/*
 * upload.js
 *
 * Copyright (c) BTL 2022.  All rights reserved.
 * 
 * Licensed under AGPL 3.0.
 */

import { Key, BlockId } from './ttbytes.js';

const blockSize = 1000000; // 1 MB
const inputElement = document.getElementById("input");

inputElement.addEventListener("change", handleFiles, false);

const MAX_TRIES = 10;

window.copy_to_clipboard = function copy_to_clipboard(selector) {
  let url = document.querySelector(selector).href;
  console.log("url", url);
  var dummy = document.createElement('input');

  document.body.appendChild(dummy);
  dummy.value = url;
  dummy.select();
  document.execCommand('copy');
  document.body.removeChild(dummy);
}

function pause(ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms);
  });
}

function wwwPrefix() {
  const l = window.location;
  if (l.hostname === "localhost") {
    return `${l.protocol}//${l.hostname}:${l.port}`;
  } else {
    return "https://www.blindupload.org"
  }
}

function cachePrefix() {
  const l = window.location;
  if (l.hostname === "localhost") {
    return `${l.protocol}//${l.hostname}:${l.port}`;
  } else {
    return "https://ca1.blindupload.org"
  }
}

const PART_LOADING = 'l';
const PART_LOADED = 'L';
const PART_UPLOADING = 'u';
const PART_UPLOADED = 'U';
const PART_ERROR = 'E';

// TODO: We should not need to use the literal values as keys.
const PART_NAMES = {
//  l: "loading",
//  L: "loaded",
//  u: "uploading",
  U: 'uploaded',
  E: 'error',
}

class UploadableFile {
  constructor(file, progressSubElementId) {
    this.file = file;
    this.reader = new FileReader();
    this.numBlocks = null;
    this.numLoadedBlocks = null;
    this.loaded = false;

    this.parts = []; // one element per MiB, PART_XXX

    this.keys = [];
    this.blockIds = [];

    // GUI
    this.progressSubElementId = progressSubElementId;
    this.updateGui();
  }

  /*
   * A representation of the file for the index.
   */
  get indexEntry() {
    return {
      name: this.file.name,
      size: this.size,
      keys: this.keys,
    }
  }

  updateGui() {
    const element = document.getElementById(this.progressSubElementId);
    const counts = {};

    for (let p of this.parts) {
      console.log("p", p);
      if (!counts[p]) {
        counts[p] = 1;
      } else {
        counts[p]++;
      }
    }
    console.log("counts", counts);

    var progress = [];
    for (var p in PART_NAMES) {
      console.log("p2", p);
      if (counts[p]) {
        progress.push(`${counts[p]}: MB ${PART_NAMES[p]}`);
      }
    }

    //element.innerHTML = `<span>${this.file.name} ${this.parts.join("")}</span>`;
    //element.innerHTML = `<span>${this.file.name} ${progress.join(", ")}</span>`
    const browseElement = document.getElementById("browse");
    browseElement.style.display = "none";
    const progressElement = document.getElementById("progress");
    progressElement.style.display = "block";
    const progressId = this.progressSubElementId + "-progress";
    const max = this.parts.length;
    var value = counts[PART_UPLOADED];
    if (!value) value = 0;
    element.innerHTML = 
      `<label for="${progressId}">${this.file.name}</label>:&nbsp;` +
      `<progress id="${progressId}" max="${max}" value="${value}">${value} MB</progress>&nbsp;` +
      `<span>${value} / ${max} MB<span>`

    //window.scrollTo(0, document.body.scrollHeight);
  }

  async read_onprogress(e, hasCompletelyLoaded) {
    console.log("onprogress e", e, "hasCompletelyLoaded", hasCompletelyLoaded);
    if (e.lengthComputable) {
      if (this.numBlocks === null) {
        this.size = e.total;
        this.numBlocks = Math.floor((e.total + blockSize - 1) / blockSize);
        console.log("setting numBlocks", this.numBlocks);
        for (var i = 0; i < this.numBlocks; ++i) {
          this.parts[i] = PART_LOADING;
        } 
        console.log("parts", this.parts.join(''));
      }
    }
    this.numLoadedBlocks = hasCompletelyLoaded ? this.numBlocks : Math.floor(e.loaded / blockSize);
    for (var i = 0; i < this.numLoadedBlocks; ++i) {
      if (this.parts[i] === PART_LOADING) {
        this.parts[i] = PART_LOADED;
      }
    }
    console.log("parts", this.parts.join(''));
    this.updateGui();
  }

  async read_onload(e, resolve) {
    console.log("onload e", e);
    await this.read_onprogress(e, true);
    this.loaded = e;
    resolve();
  }

  read() {
    console.log("read()");
    this.reader.onprogress = e => this.read_onprogress(e);
    this.reader.readAsArrayBuffer(this.file);

    // FIXME: could this cause a race?
    return new Promise((resolve, reject) => {
      this.reader.onload = e => this.read_onload(e, resolve);
    });
  }

  async upload() {
    console.log("upload()");
    for (var j = 0; j < MAX_TRIES; j++) {
      for (var i = 0; i < this.numBlocks; ++i) {
        console.log("parts", this.parts.join(''));
        if (this.parts[i] === PART_LOADED || this.parts[i] === PART_ERROR) {
          this.parts[i] = PART_UPLOADING;
          this.updateGui();
          await pause(10);
          this.parts[i] = await this.uploadBlock(i);
          this.updateGui();
          await pause(10);
        }
      }
      console.log("parts", this.parts.join(''));
    }
    // check for successful upload (after reries)
    for (var i = 0; i < this.numBlocks; ++i) {
      if (this.parts[i] != PART_UPLOADED) {
        return false;
      }
    }
    return true;
  }

  async uploadBlock(blockNum) {
    console.log("uploading blockNum", blockNum);

    // calculate hash
    const start = blockNum * blockSize;
    console.log("this.loaded", this.loaded);
    console.log("this.loaded.target", this.loaded.target);
    console.log("this.loaded.target.result", this.loaded.target.result);
    const end = Math.min(start + blockSize, this.loaded.total);
    console.log('start', start, 'end', end);
    const block = new Uint8Array(this.loaded.target.result.slice(start, end));
    console.log('block', block);

    // the keys are used both for decryption, and once hashed are used as the filenames of the blocks
    const subtleKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const key = Key.fromUint8Array(new Uint8Array(await crypto.subtle.exportKey("raw", subtleKey)));
    this.keys[blockNum] = key.base62;    

    // the block IDs are just the hashes of their keys
    const blockId = await BlockId.fromHashOfKey(key); // 128 bits is unique
    console.log("key", key, "blockId", blockId);
    this.blockIds[blockNum] = blockId.upperAsBase62;

    // encrypt block
    const ciphertext = await key.encrypt(block);

    //const hash = await crypto.subtle.digest('SHA-256', block);
    //const hashHex = buf2hex(hash);
    //console.log('hashHex', hashHex);

    // send that block
    try {
      await uploadBlock(ciphertext, cachePrefix() + "/upload/block/" + this.blockIds[blockNum]);
      return PART_UPLOADED;
    } catch (e) {
      return PART_ERROR;
    }
  }
}

// This function returns a promise, so it should be called with await.
function uploadBlock(block, url) {
  const xhr = new XMLHttpRequest;

  const promise = new Promise((resolve, reject) => {
    xhr.onloadend = res => {
      console.log("block uploaded", url, res);
      if (res.target.status < 200 || res.target.status > 299) {
        console.log("block upload error");
        try { // how can resolve fail?
          console.log("res.target.response", res.target.response);
          reject("foo");//res.target.response);
        } catch (e) {
          console.log("error inside promise's reject() ???", e);
        }
      } else {
        resolve();
      }
    };

    xhr.onerror = (e) => {
      console.log("block error");
      reject(e);
    };
  })

  xhr.open("PUT", url, true);
  xhr.send(block); 

  return promise;
}

class Uploader {
  constructor() {
    this.state = "IDLE";
    this.files = []; // Uploadable Files
  }

  addFiles(files) {
    console.log("addFiles()");
    console.log("Y files", files);
    for (let i = 0; i < files.length; ++i) {
      console.log("Z i", i, "files[i]", files[i]);

      // GUI
      const progressElement = document.getElementById("progress");
      progressElement.innerHTML += `<div id="progress-${i}">`;

      this.files.push(new UploadableFile(files[i], `progress-${i}`));
    }
  }

  async start() {
    console.log("Uploader.start()");
    console.log("X files", this.files);
    for (let file of this.files) {
      await file.read();
      await pause(10);
      const res = await file.upload();
      if (!res) {
        return alert("File upload failed.  Please press F5 and retry.");
      }
      console.log("File upload complete.");
      await pause(10);
    }
    console.log("All file uploads complete.");

    // create key
    const subtleKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const indexKey = Key.fromUint8Array(new Uint8Array(await crypto.subtle.exportKey("raw", subtleKey)));
    console.log("indexKey", indexKey.base62);

    // create index block
    const index = [];
    for (let file of this.files) {
      index.push(file.indexEntry);
    }
    const indexJson = JSON.stringify(index);
    console.log("indexJson", indexJson);

    const encoder = new TextEncoder();
    const indexBuf = encoder.encode(indexJson);

    // encrypt index block
    const ciphertext = await indexKey.encrypt(indexBuf);

    const idArr = new Uint8Array(await crypto.subtle.digest('SHA-256', indexKey.uint8Array));
    const blockId = BlockId.fromUint8Array(idArr);

    console.log("uploading index block...");

    // upload index block
    for (var i = 0; i < MAX_TRIES; ++i) {
      const res = !await uploadBlock(ciphertext, cachePrefix() + "/upload/block/" + blockId.upperAsBase62);
      if (res) break;
      if (i == MAX_TRIES) {
        return alert("Index upload failed.  Please press F5 and retry.");
      }
      await pause(100);
    }

    // show keys
    const longUrl = wwwPrefix() + "/#" + indexKey.base62;
    const longUrlHuman = wwwPrefix() + "/<wbr>#" + indexKey.base62.slice(0, 22) + "<wbr>" + indexKey.base62.slice(22);
    const shortUrl = wwwPrefix() + "/#" + indexKey.upperAsBase62;
    const shortUrlHuman = wwwPrefix() + "/<wbr>#" + indexKey.upperAsBase62;
    const code = indexKey.lowerAsDashedBase33;

    // GUI
    const progressElement = document.getElementById("progress");
    progressElement.style.display = "none";
    const completedElement = document.getElementById("completed");
    completedElement.style.display = "block";

    const longLinkElement = document.getElementById("completed-long-link");
    longLinkElement.innerHTML += `<center><a id="long-link" href="${longUrl}" target="_">${longUrlHuman}</a>&nbsp;<button onclick="copy_to_clipboard('#long-link');">Copy</button></center>`;

    new QRCode(document.getElementById("long-link-qrcode"), {
      text: longUrl,
      width: 490,
      height: 490,
      colorDark : "#000000",
      colorLight : "#ffffff",
      correctLevel : QRCode.CorrectLevel.H
    });

    const shortLinkElement = document.getElementById("completed-short-link");
    shortLinkElement.innerHTML += `<center><a id="short-link" href="${shortUrl}" target="_">${shortUrlHuman}</a>&nbsp;<button onclick="copy_to_clipboard('#short-link');">Copy</button></center>`;

    const codeElement = document.getElementById("completed-short-code");
    codeElement.innerHTML += `<center class="short-code">${code}</center>`;

    new QRCode(document.getElementById("short-link-qrcode"), {
      text: shortUrl,
      width: 410,
      height: 410,
      colorDark : "#000000",
      colorLight : "#ffffff",
      correctLevel : QRCode.CorrectLevel.H
    });

    //window.scrollTo(0, document.body.scrollHeight);

    console.log("fin");
  }
}

const uploader = new Uploader();

function handleFiles() {
  console.log("handleFiles()");
  if (this.files.length < 1) return
  uploader.addFiles(this.files);
  uploader.start();
}



