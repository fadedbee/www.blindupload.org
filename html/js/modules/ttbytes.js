/*
 * ttbytes.js
 *
 * Copyright (c) BTL 2022.  All rights reserved.
 * 
 * Licensed under AGPL 3.0.
 */

/*
 * Thirty-Two Bytes.
 *
 * The 32 bytes are stored as a BigNum, for ease of conversion to different bases.
 *
 * Representations:
 * 
 * 32x base-256 symbols (Uint8Array) (256 bits)
 * 43x base-62 symbols (256.03 bits)
 * 22x base-62 symbols (130.99 bits) and 25x base-33 symbols (126.10 bits)
 *   (The base-33 part is capped at 62^21 so that the base-62 part resembles the pure base-62 
 *    representation.)
 * 
 */


async function getSubtle() {
  if (typeof window === 'undefined') { // running in NodeJS
    const crypto = await import('crypto');
    return crypto.webcrypto.subtle;
  } else { // running in a browser
    return crypto.subtle;
  }
}

// base33 and base62
const alph = {
  "16": "0123456789ABCDEF".split(""),
  "33": "0123456789ABCDEFGHJKLMNPQRSTVWXYZ".split(""),
  "62": "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".split(""),
}
const rev = {};
for (let base of ["33", "62"]) {
  rev[base] = {};
  for (var i = 0; i < alph[base].length; ++i) {
    //console.log("i", i, "base", base, "alph", alph[base][i]);
    rev[base][alph[base][i]] = BigInt(i);
  }
}

/*
 * Converts a BigInt into a Uint8Array.
 */
function bigToBuf(big) {
  var hex = BigInt(big).toString(16);
  if (hex.length % 2) { hex = '0' + hex; }

  const len = hex.length / 2;
  const u8 = new Uint8Array(len);

  var i = 0;
  var j = 0;
  while (i < len) {
    u8[i] = parseInt(hex.slice(j, j+2), 16);
    i += 1;
    j += 2;
  }

  return u8;
}

/*
 * Converts a Uint8Array into a BigInt.
 */
function bufToBig(buf) {
  var hex = [];
  const u8 = Uint8Array.from(buf);
      
  u8.forEach(function (i) {
    var h = i.toString(16);
    if (h.length % 2) { h = '0' + h; }
    hex.push(h);
  });
  console.log("bufToBig hex", hex);
      
  return BigInt('0x' + hex.join(''));
}

function bigToBase(big, base, digits) {
  var out = "";
  const divider = BigInt(base);
  while (out.length < digits) {
    out += alph[base][big % divider]
    big = big / divider;
  }
  return out.split("").reverse().join(""); // convert to big-endian base-N
}

function baseToBig(string, base) {
  const chars = string.split("");
  var big = BigInt(0);
  const multiplier = BigInt(base);
  for (var i = 0; i < chars.length; ++i) {
    if (rev[base][chars[i]] === undefined) return null;
    big = big * multiplier + rev[base][chars[i]];
    //console.log("big", big);
  }
  return big;
}

const BASE256_DIGITS = 32n;
const BASE16_DIGITS = BASE256_DIGITS * 2n;
const BASE62_DIGITS = 43n;
const UPPER_BASE62_DIGITS = 22n;
const LOWER_BASE62_DIGITS = BASE62_DIGITS - UPPER_BASE62_DIGITS;
const LOWER_BASE33_DIGITS = 25n;
const PIVOT = 62n ** LOWER_BASE62_DIGITS; 
const MAX = 256n ** BASE256_DIGITS;
const IV = new Uint8Array(12);

class TTBytes {
  constructor(big) {
    this.big = BigInt(big) % MAX;
  }

  get base62() {
    return bigToBase(this.big, 62, BASE62_DIGITS);
  }

  get base16() {
    return bigToBase(this.big, 16, BASE16_DIGITS);
  }

  get upperAsBase62() {
    return bigToBase(this.big / PIVOT, 62, UPPER_BASE62_DIGITS);
  }

  get lowerAsBase62() { 
    return bigToBase(this.big % PIVOT, 62, LOWER_BASE62_DIGITS);
  }

  get lowerAsBase33() {
    return bigToBase(this.big % PIVOT, 33, LOWER_BASE33_DIGITS);
  }

  get lowerAsDashedBase33() {
    const base33 = this.lowerAsBase33;
    return base33.match(/.{5}/g).join("-");
  }

  get uint8Array() {
    return bigToBuf(this.big);
  }

  // These functions should be in Key, but the inherited Key.from methods currently return TTBytes.
  async encrypt(buf) {
    const subtle = await getSubtle();
    console.log('subtle', subtle);

    const aesKey = await subtle.importKey(
      'raw',
      this.uint8Array,
      { name: 'AES-GCM', },
      false,
      ['encrypt']
    )

    console.log("IV", IV);

    const ciphertext = new Uint8Array(await subtle.encrypt({
        name: 'AES-GCM',
        iv: IV,
        tagLength: 128,
      },
      aesKey,
      buf
    ));
    
    console.log("encrypt key", this.base62, "buf.length", buf.length, "ciphertext.length", ciphertext.length);

    return ciphertext;
  }

  async decrypt(buf) {
    const subtle = await getSubtle();

    try {
      console.log("decrypt", buf, this.base62);
      const aesKey = await subtle.importKey(
        'raw',
        this.uint8Array,
        { name: 'AES-GCM', },
        false,
        ['decrypt']
      )
      console.log("aesKey", aesKey);

      const plaintext = new Uint8Array(await subtle.decrypt({
          name: 'AES-GCM',
          iv: IV,
          tagLength: 128,
        },
        aesKey,
        buf
      ));

      console.log("decrypt key", this.base62, "buf.length", buf.length, "plaintext.length", plaintext.length);

      return plaintext;
    } catch (e) {
      console.log(e);
    }
  }

}

TTBytes.fromUint8Array = function(arr) {
  return new TTBytes(bufToBig(arr));
}

TTBytes.fromBase62 = function(base62) {
  return new TTBytes(baseToBig(base62, 62));
}

TTBytes.fromBase62andBase33 = function(base62, base33) {
  try {
    return new TTBytes(baseToBig(base62, 62) * PIVOT + baseToBig(base33, 33) % PIVOT);
  } catch (e) {
    return null;
  }
}

// FIXME: This can produce bad keys.
TTBytes.fromRandomValues = function() {
  const keyArr = new Uint8Array(32);
  self.crypto.getRandomValues(keyArr);
  return TTBytes.fromUint8Array(keyArr);
}

class Key extends TTBytes {
}

function ivFromNum(num) {
  const iv = new Uint8Array(12);
  for (var i = 0; i < 12 && num > 0; ++i) {
    iv[i] = num % 256;
    num /= 256;
  }
  return iv;
}

class BlockId extends TTBytes {
}

BlockId.fromHashOfKey = async function(key) {
  const idArr = new Uint8Array(await crypto.subtle.digest('SHA-256', key.uint8Array));
  return BlockId.fromUint8Array(idArr);
}

export { alph, rev, bigToBuf, bufToBig, bigToBase, baseToBig, TTBytes, Key, BlockId, BASE62_DIGITS,
  UPPER_BASE62_DIGITS };
