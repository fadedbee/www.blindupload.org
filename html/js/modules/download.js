/*
 * download.js
 *
 * Copyright (c) BTL 2022.  All rights reserved.
 * 
 * Licensed under AGPL 3.0.
 */

import { Key, BlockId, BASE62_DIGITS, UPPER_BASE62_DIGITS } from './ttbytes.js';
//import { saveAs } from './save_as.js';

const TAIL_LENGTH = 32;

var index; // TODO: module-level variable is still a little too global for my taste

function cachePrefix() {
  const l = window.location;
  if (l.hostname === "localhost") {
    return `${l.protocol}//${l.hostname}:${l.port}/`;
  } else {
    return "https://ca1.blindupload.org/"
  }
}

function buf2hex(buf) {
  return [...new Uint8Array (buf)]
      .map (b => b.toString (16).padStart (2, "0"))
      .join ("");
}

function utf8toBuf(utf8) {
  const encoder = new TextEncoder();
  const buf = encoder.encode(utf8); 
  console.log("utf8", utf8);
  console.log("buf", buf);
  return buf;
}

function buf2utf8(buf) {
  const decoder = new TextDecoder();
  return decoder.decode(buf); 
}

function humanSize(size) {
  if (size < 1000) return size + " bytes";
  if (size < 1000000) return Math.floor(size / 1000) + " KB";
  if (size < 1000000000) return Math.floor(size / 1000000) + " MB";
  if (size < 1000000000000) return Math.floor(size / 1000000000) + " GB";
}

// get anchor tag
function getAnchor() {
  var currentUrl = window.document.URL,
  urlParts = currentUrl.split('#');
  return (urlParts.length > 1) ? urlParts[1] : null;
}

window.addEventListener('hashchange', function(){
  console.log('hash changed!');
  init();
})

window.moveToNext = (current, nextFieldId) => {  
  if (current.value.length >= current.maxLength) {  
    document.getElementById(nextFieldId).disabled = false;  
    document.getElementById(nextFieldId).focus();  
  }  
};  

window.codeComplete = async () => {
  const code = document.getElementById('code0').value
             + document.getElementById('code1').value
             + document.getElementById('code2').value
             + document.getElementById('code3').value
             + document.getElementById('code4').value;
  const key = Key.fromBase62andBase33(getAnchor(), code);
  console.log("code", code);
  if (!key) {
    console.error("bad key");
    const errorReport = window.document.getElementById('error-report');
    errorReport.style.display = 'block';
    errorReport.innerHTML = `<p class="error">Error: Bad Code, please check that you have typed it correctly.</p>`;
    return;
  }
  console.log("key", key.base62);
  await downloadIndex(key);
};

const SLASH_HTML = utf8toBuf("</html>\n");

// This function returns a promise, so it should be called with await.
function downloadBlock(url) {
  const xhr = new XMLHttpRequest;

  const promise = new Promise((resolve, reject) => {
    xhr.onload = () => {
      //console.log("responseType", xhr.responseType);

      if (xhr.status == 404) return reject("404 file not found.  Incorrect code or expired link.")
      if (xhr.status != 200) return reject("Unexpected HTTP code: " + xhr.status);

      if (xhr.responseType !== "arraybuffer") {
        return reject("responseType was not arraybuffer");
      }

      const paddedBlock = new Uint8Array(xhr.response);

      //console.log("paddedBlock", buf2utf8(paddedBlock));
      //console.log("slash html", buf2utf8(SLASH_HTML));

      outer:
      for (var i = 0; i < paddedBlock.length; ++i) {
        for (var j = 0; j < SLASH_HTML.length; ++j) {
          //console.log(`paddedBlock[${i+j}]`, paddedBlock[i+j], `SLASH_HTML[${j}]`, SLASH_HTML[j]);
          if (paddedBlock[i+j] !== SLASH_HTML[j]) continue outer; // not found it yet
        }
        // found it
        const trimmed = paddedBlock.subarray(i + SLASH_HTML.length, paddedBlock.length - TAIL_LENGTH);
        console.log("trimmed.length", trimmed.length);
        return resolve(trimmed);
      }

      reject("</html>\\n not found in download");
    };

    xhr.onerror = (e) => {
      console.log("block error");
      reject(e);
    };
  })

  xhr.open("GET", url, true);
  xhr.responseType = "arraybuffer";
  xhr.send(); 

  return promise;
}

async function handleLongAnchor(anchor) {
  const key = Key.fromBase62(anchor);
  if (!key) {
    console.error("bad key");
    return;
  }
  console.log("key", key.base62);
  await downloadIndex(key);
}

const urlPrefix = cachePrefix() + "block/";

async function downloadIndex(key) {
  try {
    // the block IDs are just the hashes of their keys
    const idArr = new Uint8Array(await crypto.subtle.digest('SHA-256', key.uint8Array));
    const blockId = BlockId.fromUint8Array(idArr);

    const url = urlPrefix + blockId.upperAsBase62;
    console.log("url", url);
    const block = await downloadBlock(url);
    console.log("block", block);
    const plaintext = await key.decrypt(block)
    console.log("plaintext", plaintext);
    index = JSON.parse(buf2utf8(plaintext));
    console.log("index", index);

    // show files in index
    const fileList = window.document.getElementById('file-list');
    fileList.style.display = 'block';
    for (var i in index) {
      const file = index[i];
      const fileSize = humanSize(file.size);
      fileList.innerHTML += `
        <p id="file-${i}">
          ${file.name} ${fileSize}
          <button onclick="downloadFile(${i});return false;">Download and Decrypt</button>
        </p>
      `;
    }
  } catch (e) {
    console.log("error", e);
    const errorReport = window.document.getElementById('error-report');
    errorReport.style.display = 'block';
    errorReport.innerHTML += `<p class="error">Error: ${e}</p>`;
  }
}

async function downloadFile(num) {
  try {
    const file = index[num];
    console.log(`downloading ${file.name}`);

    // create a buffer to write into
    const buf = new Uint8Array(file.size);
    var offset = 0;

    for (var i = 0; i < file.keys.length; ++i) {
      // GUI
      const fileElement = document.getElementById("file-" + num);
      fileElement.innerHTML = `
        ${file.name}
        <progress max="${file.keys.length}" value="${i}">${i} MB</progress>&nbsp;
        <span>${i} / ${file.keys.length} MB<span>
      `;

      // the block IDs are just the hashes of their keys
      const key = Key.fromBase62(file.keys[i]);
      const blockId = await BlockId.fromHashOfKey(key);

      const url = urlPrefix + blockId.upperAsBase62;// + ".block";
      const block = await downloadBlock(url);

      // TODO: check length of dowloaded block, it should be BLOCK_SIZE for all but the last
      // TODO: check the hash of the downloaded block

      // decrypt the downloaded block
      const plaintext = await key.decrypt(block);

      console.log("block.length", block.length, "plaintext.length", plaintext.length);

      for (var j = 0; j < plaintext.length; ++j) {
        buf[offset + j] = plaintext[j];      
      }
      offset += plaintext.length;
    }
    // GUI
    const fileElement = document.getElementById("file-" + num);
    fileElement.innerHTML = `
      ${file.name}
      <progress max="${file.keys.length}" value="${file.keys.length}">${file.keys.length} MB</progress>&nbsp;
      <span>${file.keys.length} / ${file.keys.length} MB<span>
    `;

    // TODO: check the hash of the unencrypted buffer against a new "file.hash" property
    if (offset !== file.size) {
      throw `expected ${file.size} bytes, received ${offset}`;
    }

    console.log(`downloaded ${file.name}`);
    const blob = new Blob([buf], {type: "application/octet-stream"});
    //saveAs(blob, file.name);

    var a = document.createElement("a"), url = URL.createObjectURL(blob);
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);

	  a.click();
  } catch (e) {
    console.log("error", e);
    const errorReport = window.document.getElementById('error-report');
    errorReport.style.display = 'block';
    errorReport.innerHTML = `<p class="error">Error: ${e}</p>`;
  }
}
window.downloadFile = downloadFile; // it needs to be called from a button's onclick

async function handleShortAnchor(anchor) {
  window.document.getElementById('code-required').style.display = 'block';
  document.getElementById('code0').focus();
}

async function init() {
  console.log("init");

  // reset the UI
  window.document.getElementById('file-list').style.display = 'none';
  window.document.getElementById('file-list').innerHTML = '';
  window.document.getElementById('code-required').style.display = 'none';
  window.document.getElementById('error-report').style.display = 'none';
  window.document.getElementById('error-report').innerHTML = '';

  // initialise
  var anchor = getAnchor();
  console.log('anchor', anchor);
  console.log('!!anchor', !!anchor);

  if (!anchor) {
    console.log('redirecting due to lack of anchor');
    location.href = '/upload.html';
  }

  if (anchor.length == BASE62_DIGITS) {
    console.log("long anchor");
    await handleLongAnchor(anchor);
  } else if (anchor.length == UPPER_BASE62_DIGITS) {
    console.log("short anchor");
    await handleShortAnchor(anchor);
  } else {
    console.log("anchor.length", anchor.length);
    console.error("bad anchor");
  }


}

await init();