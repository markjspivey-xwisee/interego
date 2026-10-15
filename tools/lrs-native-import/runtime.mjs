import { createRequire as __maintenanceCreateRequire } from "node:module"; const require = __maintenanceCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod2) => function __require2() {
  return mod2 || (0, cb[__getOwnPropNames(cb)[0]])((mod2 = { exports: {} }).exports, mod2), mod2.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod2, isNodeMode, target) => (target = mod2 != null ? __create(__getProtoOf(mod2)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod2 || !mod2.__esModule ? __defProp(target, "default", { value: mod2, enumerable: true }) : target,
  mod2
));

// ../interego-native88/packages/core/src/model/types.ts
var init_types = __esm({
  "../interego-native88/packages/core/src/model/types.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/model/descriptor.ts
var init_descriptor = __esm({
  "../interego-native88/packages/core/src/model/descriptor.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/model/registry.ts
function registerFacetType(type, entry) {
  _registry.set(type, entry);
}
var _registry;
var init_registry = __esm({
  "../interego-native88/packages/core/src/model/registry.ts"() {
    "use strict";
    _registry = /* @__PURE__ */ new Map();
    registerFacetType("Temporal", {
      unionStrategy: "convex-hull",
      intersectionStrategy: "intersect-range"
    });
    registerFacetType("Provenance", {
      unionStrategy: "chain",
      intersectionStrategy: "chain"
    });
    registerFacetType("Agent", {
      unionStrategy: "preserve-all",
      intersectionStrategy: "preserve-all"
    });
    registerFacetType("AccessControl", {
      unionStrategy: "flatten-set",
      intersectionStrategy: "flatten-set"
    });
    registerFacetType("Semiotic", {
      unionStrategy: "preserve-all",
      intersectionStrategy: "preserve-all"
    });
    registerFacetType("Trust", {
      unionStrategy: "preserve-all",
      intersectionStrategy: "preserve-all"
    });
    registerFacetType("Federation", {
      unionStrategy: "preserve-all",
      intersectionStrategy: "preserve-all"
    });
    registerFacetType("Causal", {
      unionStrategy: "preserve-all",
      intersectionStrategy: "preserve-all"
    });
    registerFacetType("Projection", {
      unionStrategy: "merge-bindings",
      intersectionStrategy: "merge-bindings"
    });
  }
});

// ../interego-native88/packages/core/src/canonical-json.ts
var init_canonical_json = __esm({
  "../interego-native88/packages/core/src/canonical-json.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/model/descriptor-shape.ts
var init_descriptor_shape = __esm({
  "../interego-native88/packages/core/src/model/descriptor-shape.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/model/composition.ts
var init_composition = __esm({
  "../interego-native88/packages/core/src/model/composition.ts"() {
    "use strict";
    init_registry();
    init_canonical_json();
    init_descriptor_shape();
  }
});

// ../../d258232b77e2/interego-durability/node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
function anumber(n, title = "") {
  if (typeof n !== "number") {
    const prefix = title && `"${title}" `;
    throw new TypeError(`${prefix}expected number, got ${typeof n}`);
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    const prefix = title && `"${title}" `;
    throw new RangeError(`${prefix}expected integer >= 0, got ${n}`);
  }
}
function abytes(value2, length, title = "") {
  const bytes = isBytes(value2);
  const len = value2?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value2}`;
    const message = prefix + "expected Uint8Array" + ofLen + ", got " + got;
    if (!bytes)
      throw new TypeError(message);
    throw new RangeError(message);
  }
  return value2;
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "digestInto() output");
  const min = instance.outputLen;
  if (out.length < min) {
    throw new RangeError('"digestInto() output" expected to be of length >=' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9)
    return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F)
    return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f)
    return ch - (asciis.a - 10);
  return;
}
function hexToBytes(hex) {
  if (typeof hex !== "string")
    throw new TypeError("hex string expected, got " + typeof hex);
  if (hasHexBuiltin) {
    try {
      return Uint8Array.fromHex(hex);
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new RangeError(error.message);
      throw error;
    }
  }
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new RangeError("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex[hi] + hex[hi + 1];
      throw new RangeError('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function utf8ToBytes(str2) {
  if (typeof str2 !== "string")
    throw new TypeError("string expected");
  return new Uint8Array(new TextEncoder().encode(str2));
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function createHasher(hashCons, info = {}) {
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
var hasHexBuiltin, hexes, asciis, oidNist;
var init_utils = __esm({
  "../../d258232b77e2/interego-durability/node_modules/@noble/hashes/utils.js"() {
    hasHexBuiltin = /* @__PURE__ */ (() => (
      // @ts-ignore
      typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
    ))();
    hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
    asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
    oidNist = (suffix) => ({
      // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
      // Larger suffix values would need base-128 OID encoding and a different length byte.
      oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
    });
  }
});

// ../../d258232b77e2/interego-durability/node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD, SHA256_IV, SHA512_IV;
var init_md = __esm({
  "../../d258232b77e2/interego-durability/node_modules/@noble/hashes/_md.js"() {
    init_utils();
    HashMD = class {
      blockLen;
      outputLen;
      canXOF = false;
      padOffset;
      isLE;
      // For partial updates less than block size
      buffer;
      view;
      finished = false;
      length = 0;
      pos = 0;
      destroyed = false;
      constructor(blockLen, outputLen, padOffset, isLE) {
        this.blockLen = blockLen;
        this.outputLen = outputLen;
        this.padOffset = padOffset;
        this.isLE = isLE;
        this.buffer = new Uint8Array(blockLen);
        this.view = createView(this.buffer);
      }
      update(data) {
        aexists(this);
        abytes(data);
        const { view, buffer, blockLen } = this;
        const len = data.length;
        for (let pos = 0; pos < len; ) {
          const take = Math.min(blockLen - this.pos, len - pos);
          if (take === blockLen) {
            const dataView = createView(data);
            for (; blockLen <= len - pos; pos += blockLen)
              this.process(dataView, pos);
            continue;
          }
          buffer.set(data.subarray(pos, pos + take), this.pos);
          this.pos += take;
          pos += take;
          if (this.pos === blockLen) {
            this.process(view, 0);
            this.pos = 0;
          }
        }
        this.length += data.length;
        this.roundClean();
        return this;
      }
      digestInto(out) {
        aexists(this);
        aoutput(out, this);
        this.finished = true;
        const { buffer, view, blockLen, isLE } = this;
        let { pos } = this;
        buffer[pos++] = 128;
        clean(this.buffer.subarray(pos));
        if (this.padOffset > blockLen - pos) {
          this.process(view, 0);
          pos = 0;
        }
        for (let i = pos; i < blockLen; i++)
          buffer[i] = 0;
        view.setBigUint64(blockLen - 8, BigInt(this.length * 8), isLE);
        this.process(view, 0);
        const oview = createView(out);
        const len = this.outputLen;
        if (len % 4)
          throw new Error("_sha2: outputLen must be aligned to 32bit");
        const outLen = len / 4;
        const state = this.get();
        if (outLen > state.length)
          throw new Error("_sha2: outputLen bigger than state");
        for (let i = 0; i < outLen; i++)
          oview.setUint32(4 * i, state[i], isLE);
      }
      digest() {
        const { buffer, outputLen } = this;
        this.digestInto(buffer);
        const res = buffer.slice(0, outputLen);
        this.destroy();
        return res;
      }
      _cloneInto(to) {
        to ||= new this.constructor();
        to.set(...this.get());
        const { blockLen, buffer, length, finished, destroyed, pos } = this;
        to.destroyed = destroyed;
        to.finished = finished;
        to.length = length;
        to.pos = pos;
        if (length % blockLen)
          to.buffer.set(buffer);
        return to;
      }
      clone() {
        return this._cloneInto();
      }
    };
    SHA256_IV = /* @__PURE__ */ Uint32Array.from([
      1779033703,
      3144134277,
      1013904242,
      2773480762,
      1359893119,
      2600822924,
      528734635,
      1541459225
    ]);
    SHA512_IV = /* @__PURE__ */ Uint32Array.from([
      1779033703,
      4089235720,
      3144134277,
      2227873595,
      1013904242,
      4271175723,
      2773480762,
      1595750129,
      1359893119,
      2917565137,
      2600822924,
      725511199,
      528734635,
      4215389547,
      1541459225,
      327033209
    ]);
  }
});

// ../../d258232b77e2/interego-durability/node_modules/@noble/hashes/_u64.js
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var U32_MASK64, _32n, shrSH, shrSL, rotrSH, rotrSL, rotrBH, rotrBL, add3L, add3H, add4L, add4H, add5L, add5H;
var init_u64 = __esm({
  "../../d258232b77e2/interego-durability/node_modules/@noble/hashes/_u64.js"() {
    U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
    _32n = /* @__PURE__ */ BigInt(32);
    shrSH = (h, _l, s) => h >>> s;
    shrSL = (h, l, s) => h << 32 - s | l >>> s;
    rotrSH = (h, l, s) => h >>> s | l << 32 - s;
    rotrSL = (h, l, s) => h << 32 - s | l >>> s;
    rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
    rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
    add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
    add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
    add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
    add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
    add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
    add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;
  }
});

// ../../d258232b77e2/interego-durability/node_modules/@noble/hashes/sha2.js
var SHA256_K, SHA256_W, SHA2_32B, _SHA256, K512, SHA512_Kh, SHA512_Kl, SHA512_W_H, SHA512_W_L, SHA2_64B, _SHA512, sha256, sha512;
var init_sha2 = __esm({
  "../../d258232b77e2/interego-durability/node_modules/@noble/hashes/sha2.js"() {
    init_md();
    init_u64();
    init_utils();
    SHA256_K = /* @__PURE__ */ Uint32Array.from([
      1116352408,
      1899447441,
      3049323471,
      3921009573,
      961987163,
      1508970993,
      2453635748,
      2870763221,
      3624381080,
      310598401,
      607225278,
      1426881987,
      1925078388,
      2162078206,
      2614888103,
      3248222580,
      3835390401,
      4022224774,
      264347078,
      604807628,
      770255983,
      1249150122,
      1555081692,
      1996064986,
      2554220882,
      2821834349,
      2952996808,
      3210313671,
      3336571891,
      3584528711,
      113926993,
      338241895,
      666307205,
      773529912,
      1294757372,
      1396182291,
      1695183700,
      1986661051,
      2177026350,
      2456956037,
      2730485921,
      2820302411,
      3259730800,
      3345764771,
      3516065817,
      3600352804,
      4094571909,
      275423344,
      430227734,
      506948616,
      659060556,
      883997877,
      958139571,
      1322822218,
      1537002063,
      1747873779,
      1955562222,
      2024104815,
      2227730452,
      2361852424,
      2428436474,
      2756734187,
      3204031479,
      3329325298
    ]);
    SHA256_W = /* @__PURE__ */ new Uint32Array(64);
    SHA2_32B = class extends HashMD {
      constructor(outputLen) {
        super(64, outputLen, 8, false);
      }
      get() {
        const { A: A2, B, C, D: D2, E, F, G: G4, H: H3 } = this;
        return [A2, B, C, D2, E, F, G4, H3];
      }
      // prettier-ignore
      set(A2, B, C, D2, E, F, G4, H3) {
        this.A = A2 | 0;
        this.B = B | 0;
        this.C = C | 0;
        this.D = D2 | 0;
        this.E = E | 0;
        this.F = F | 0;
        this.G = G4 | 0;
        this.H = H3 | 0;
      }
      process(view, offset) {
        for (let i = 0; i < 16; i++, offset += 4)
          SHA256_W[i] = view.getUint32(offset, false);
        for (let i = 16; i < 64; i++) {
          const W15 = SHA256_W[i - 15];
          const W2 = SHA256_W[i - 2];
          const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
          const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
          SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
        }
        let { A: A2, B, C, D: D2, E, F, G: G4, H: H3 } = this;
        for (let i = 0; i < 64; i++) {
          const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
          const T1 = H3 + sigma1 + Chi(E, F, G4) + SHA256_K[i] + SHA256_W[i] | 0;
          const sigma0 = rotr(A2, 2) ^ rotr(A2, 13) ^ rotr(A2, 22);
          const T2 = sigma0 + Maj(A2, B, C) | 0;
          H3 = G4;
          G4 = F;
          F = E;
          E = D2 + T1 | 0;
          D2 = C;
          C = B;
          B = A2;
          A2 = T1 + T2 | 0;
        }
        A2 = A2 + this.A | 0;
        B = B + this.B | 0;
        C = C + this.C | 0;
        D2 = D2 + this.D | 0;
        E = E + this.E | 0;
        F = F + this.F | 0;
        G4 = G4 + this.G | 0;
        H3 = H3 + this.H | 0;
        this.set(A2, B, C, D2, E, F, G4, H3);
      }
      roundClean() {
        clean(SHA256_W);
      }
      destroy() {
        this.destroyed = true;
        this.set(0, 0, 0, 0, 0, 0, 0, 0);
        clean(this.buffer);
      }
    };
    _SHA256 = class extends SHA2_32B {
      // We cannot use array here since array allows indexing by variable
      // which means optimizer/compiler cannot use registers.
      A = SHA256_IV[0] | 0;
      B = SHA256_IV[1] | 0;
      C = SHA256_IV[2] | 0;
      D = SHA256_IV[3] | 0;
      E = SHA256_IV[4] | 0;
      F = SHA256_IV[5] | 0;
      G = SHA256_IV[6] | 0;
      H = SHA256_IV[7] | 0;
      constructor() {
        super(32);
      }
    };
    K512 = /* @__PURE__ */ (() => split([
      "0x428a2f98d728ae22",
      "0x7137449123ef65cd",
      "0xb5c0fbcfec4d3b2f",
      "0xe9b5dba58189dbbc",
      "0x3956c25bf348b538",
      "0x59f111f1b605d019",
      "0x923f82a4af194f9b",
      "0xab1c5ed5da6d8118",
      "0xd807aa98a3030242",
      "0x12835b0145706fbe",
      "0x243185be4ee4b28c",
      "0x550c7dc3d5ffb4e2",
      "0x72be5d74f27b896f",
      "0x80deb1fe3b1696b1",
      "0x9bdc06a725c71235",
      "0xc19bf174cf692694",
      "0xe49b69c19ef14ad2",
      "0xefbe4786384f25e3",
      "0x0fc19dc68b8cd5b5",
      "0x240ca1cc77ac9c65",
      "0x2de92c6f592b0275",
      "0x4a7484aa6ea6e483",
      "0x5cb0a9dcbd41fbd4",
      "0x76f988da831153b5",
      "0x983e5152ee66dfab",
      "0xa831c66d2db43210",
      "0xb00327c898fb213f",
      "0xbf597fc7beef0ee4",
      "0xc6e00bf33da88fc2",
      "0xd5a79147930aa725",
      "0x06ca6351e003826f",
      "0x142929670a0e6e70",
      "0x27b70a8546d22ffc",
      "0x2e1b21385c26c926",
      "0x4d2c6dfc5ac42aed",
      "0x53380d139d95b3df",
      "0x650a73548baf63de",
      "0x766a0abb3c77b2a8",
      "0x81c2c92e47edaee6",
      "0x92722c851482353b",
      "0xa2bfe8a14cf10364",
      "0xa81a664bbc423001",
      "0xc24b8b70d0f89791",
      "0xc76c51a30654be30",
      "0xd192e819d6ef5218",
      "0xd69906245565a910",
      "0xf40e35855771202a",
      "0x106aa07032bbd1b8",
      "0x19a4c116b8d2d0c8",
      "0x1e376c085141ab53",
      "0x2748774cdf8eeb99",
      "0x34b0bcb5e19b48a8",
      "0x391c0cb3c5c95a63",
      "0x4ed8aa4ae3418acb",
      "0x5b9cca4f7763e373",
      "0x682e6ff3d6b2b8a3",
      "0x748f82ee5defb2fc",
      "0x78a5636f43172f60",
      "0x84c87814a1f0ab72",
      "0x8cc702081a6439ec",
      "0x90befffa23631e28",
      "0xa4506cebde82bde9",
      "0xbef9a3f7b2c67915",
      "0xc67178f2e372532b",
      "0xca273eceea26619c",
      "0xd186b8c721c0c207",
      "0xeada7dd6cde0eb1e",
      "0xf57d4f7fee6ed178",
      "0x06f067aa72176fba",
      "0x0a637dc5a2c898a6",
      "0x113f9804bef90dae",
      "0x1b710b35131c471b",
      "0x28db77f523047d84",
      "0x32caab7b40c72493",
      "0x3c9ebe0a15c9bebc",
      "0x431d67c49c100d4c",
      "0x4cc5d4becb3e42b6",
      "0x597f299cfc657e2a",
      "0x5fcb6fab3ad6faec",
      "0x6c44198c4a475817"
    ].map((n) => BigInt(n))))();
    SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
    SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
    SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
    SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
    SHA2_64B = class extends HashMD {
      constructor(outputLen) {
        super(128, outputLen, 16, false);
      }
      // prettier-ignore
      get() {
        const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
      }
      // prettier-ignore
      set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
        this.Ah = Ah | 0;
        this.Al = Al | 0;
        this.Bh = Bh | 0;
        this.Bl = Bl | 0;
        this.Ch = Ch | 0;
        this.Cl = Cl | 0;
        this.Dh = Dh | 0;
        this.Dl = Dl | 0;
        this.Eh = Eh | 0;
        this.El = El | 0;
        this.Fh = Fh | 0;
        this.Fl = Fl | 0;
        this.Gh = Gh | 0;
        this.Gl = Gl | 0;
        this.Hh = Hh | 0;
        this.Hl = Hl | 0;
      }
      process(view, offset) {
        for (let i = 0; i < 16; i++, offset += 4) {
          SHA512_W_H[i] = view.getUint32(offset);
          SHA512_W_L[i] = view.getUint32(offset += 4);
        }
        for (let i = 16; i < 80; i++) {
          const W15h = SHA512_W_H[i - 15] | 0;
          const W15l = SHA512_W_L[i - 15] | 0;
          const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
          const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
          const W2h = SHA512_W_H[i - 2] | 0;
          const W2l = SHA512_W_L[i - 2] | 0;
          const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
          const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
          const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
          const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
          SHA512_W_H[i] = SUMh | 0;
          SHA512_W_L[i] = SUMl | 0;
        }
        let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        for (let i = 0; i < 80; i++) {
          const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
          const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
          const CHIh = Eh & Fh ^ ~Eh & Gh;
          const CHIl = El & Fl ^ ~El & Gl;
          const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
          const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
          const T1l = T1ll | 0;
          const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
          const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
          const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
          const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
          Hh = Gh | 0;
          Hl = Gl | 0;
          Gh = Fh | 0;
          Gl = Fl | 0;
          Fh = Eh | 0;
          Fl = El | 0;
          ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
          Dh = Ch | 0;
          Dl = Cl | 0;
          Ch = Bh | 0;
          Cl = Bl | 0;
          Bh = Ah | 0;
          Bl = Al | 0;
          const All = add3L(T1l, sigma0l, MAJl);
          Ah = add3H(All, T1h, sigma0h, MAJh);
          Al = All | 0;
        }
        ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
        ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
        ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
        ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
        ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
        ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
        ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
        ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
        this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
      }
      roundClean() {
        clean(SHA512_W_H, SHA512_W_L);
      }
      destroy() {
        this.destroyed = true;
        clean(this.buffer);
        this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      }
    };
    _SHA512 = class extends SHA2_64B {
      Ah = SHA512_IV[0] | 0;
      Al = SHA512_IV[1] | 0;
      Bh = SHA512_IV[2] | 0;
      Bl = SHA512_IV[3] | 0;
      Ch = SHA512_IV[4] | 0;
      Cl = SHA512_IV[5] | 0;
      Dh = SHA512_IV[6] | 0;
      Dl = SHA512_IV[7] | 0;
      Eh = SHA512_IV[8] | 0;
      El = SHA512_IV[9] | 0;
      Fh = SHA512_IV[10] | 0;
      Fl = SHA512_IV[11] | 0;
      Gh = SHA512_IV[12] | 0;
      Gl = SHA512_IV[13] | 0;
      Hh = SHA512_IV[14] | 0;
      Hl = SHA512_IV[15] | 0;
      constructor() {
        super(64);
      }
    };
    sha256 = /* @__PURE__ */ createHasher(
      () => new _SHA256(),
      /* @__PURE__ */ oidNist(1)
    );
    sha512 = /* @__PURE__ */ createHasher(
      () => new _SHA512(),
      /* @__PURE__ */ oidNist(3)
    );
  }
});

// ../interego-native88/packages/core/src/rdf/namespaces.ts
function canonicalize(iri2) {
  return iri2.startsWith(CG_LEGACY) ? `${IEP}${iri2.slice(CG_LEGACY.length)}` : iri2;
}
var IEP, CG_LEGACY, CG, IEH, CGH_LEGACY, RDFS, SHACL, DCAT, HYDRA, CGClass, CGProp, CGContextType, CGCompositionOp, CGModalStatus, CGTrustLevel, CGAgentRole, CGSyncProtocol;
var init_namespaces = __esm({
  "../interego-native88/packages/core/src/rdf/namespaces.ts"() {
    "use strict";
    IEP = "https://markjspivey-xwisee.github.io/interego/ns/iep#";
    CG_LEGACY = "https://markjspivey-xwisee.github.io/interego/ns/cg#";
    CG = IEP;
    IEH = "https://markjspivey-xwisee.github.io/interego/ns/harness#";
    CGH_LEGACY = "https://markjspivey-xwisee.github.io/interego/ns/cgh#";
    RDFS = "http://www.w3.org/2000/01/rdf-schema#";
    SHACL = "http://www.w3.org/ns/shacl#";
    DCAT = "http://www.w3.org/ns/dcat#";
    HYDRA = "http://www.w3.org/ns/hydra/core#";
    CGClass = {
      ContextDescriptor: `${CG}ContextDescriptor`,
      ComposedDescriptor: `${CG}ComposedDescriptor`,
      ContextFacet: `${CG}ContextFacet`,
      TemporalFacet: `${CG}TemporalFacet`,
      ProvenanceFacet: `${CG}ProvenanceFacet`,
      AgentFacet: `${CG}AgentFacet`,
      AccessControlFacet: `${CG}AccessControlFacet`,
      SemioticFacet: `${CG}SemioticFacet`,
      TrustFacet: `${CG}TrustFacet`,
      FederationFacet: `${CG}FederationFacet`,
      ContextType: `${CG}ContextType`,
      CompositionOperator: `${CG}CompositionOperator`,
      PodDirectory: `${CG}PodDirectory`,
      DataProduct: `${CG}DataProduct`,
      Affordance: `${CG}Affordance`,
      CausalFacet: `${CG}CausalFacet`,
      StructuralCausalModel: `${CG}StructuralCausalModel`,
      CausalVariable: `${CG}CausalVariable`,
      CausalEdge: `${CG}CausalEdge`,
      ProjectionFacet: `${CG}ProjectionFacet`,
      ExternalBinding: `${CG}ExternalBinding`,
      VocabularyMapping: `${CG}VocabularyMapping`
    };
    CGProp = {
      describes: `${CG}describes`,
      hasFacet: `${CG}hasFacet`,
      hasFacetType: `${CG}hasFacetType`,
      compositionOp: `${CG}compositionOp`,
      operand: `${CG}operand`,
      restrictToType: `${CG}restrictToType`,
      supersedes: `${CG}supersedes`,
      version: `${CG}version`,
      validFrom: `${CG}validFrom`,
      validUntil: `${CG}validUntil`,
      temporalResolution: `${CG}temporalResolution`,
      temporalRelation: `${CG}temporalRelation`,
      provenanceChain: `${CG}provenanceChain`,
      assertingAgent: `${CG}assertingAgent`,
      onBehalfOf: `${CG}onBehalfOf`,
      agentRole: `${CG}agentRole`,
      agentIdentity: `${CG}agentIdentity`,
      authorization: `${CG}authorization`,
      consentBasis: `${CG}consentBasis`,
      interpretationFrame: `${CG}interpretationFrame`,
      signSystem: `${CG}signSystem`,
      groundTruth: `${CG}groundTruth`,
      modalStatus: `${CG}modalStatus`,
      epistemicConfidence: `${CG}epistemicConfidence`,
      languageTag: `${CG}languageTag`,
      verifiableCredential: `${CG}verifiableCredential`,
      issuer: `${CG}issuer`,
      proofMechanism: `${CG}proofMechanism`,
      trustLevel: `${CG}trustLevel`,
      revocationStatus: `${CG}revocationStatus`,
      origin: `${CG}origin`,
      storageEndpoint: `${CG}storageEndpoint`,
      syncProtocol: `${CG}syncProtocol`,
      replicaOf: `${CG}replicaOf`,
      lastSynced: `${CG}lastSynced`,
      hasPod: `${CG}hasPod`,
      podUrl: `${CG}podUrl`,
      // Affordance & DPROD alignment
      affordance: `${CG}affordance`,
      canPublish: `${CG}canPublish`,
      canDiscover: `${CG}canDiscover`,
      canSubscribe: `${CG}canSubscribe`,
      dataProduct: `${CG}dataProduct`,
      outputPort: `${CG}outputPort`,
      inputPort: `${CG}inputPort`,
      // Causal (Pearl's SCM framework)
      causalModel: `${CG}causalModel`,
      causalRole: `${CG}causalRole`,
      causalVariable: `${CG}causalVariable`,
      causalEdge: `${CG}causalEdge`,
      causes: `${CG}causes`,
      mechanism: `${CG}mechanism`,
      intervenes: `${CG}intervenes`,
      interventionValue: `${CG}interventionValue`,
      parentObservation: `${CG}parentObservation`,
      parentIntervention: `${CG}parentIntervention`,
      effectSize: `${CG}effectSize`,
      causalConfidence: `${CG}causalConfidence`,
      counterfactualTarget: `${CG}counterfactualTarget`,
      counterfactualEvidence: `${CG}counterfactualEvidence`,
      // Projection / Vocabulary Translation
      binding: `${CG}binding`,
      bindingStrength: `${CG}bindingStrength`,
      targetVocabulary: `${CG}targetVocabulary`,
      vocabularyMapping: `${CG}vocabularyMapping`,
      mappingType: `${CG}mappingType`,
      mappingRelationship: `${CG}mappingRelationship`,
      boundaryShapes: `${CG}boundaryShapes`,
      selective: `${CG}selective`,
      exposedEntity: `${CG}exposedEntity`,
      hiddenEntity: `${CG}hiddenEntity`
    };
    CGContextType = {
      Temporal: `${CG}Temporal`,
      Provenance: `${CG}Provenance`,
      Agent: `${CG}Agent`,
      AccessControl: `${CG}AccessControl`,
      Semiotic: `${CG}Semiotic`,
      Trust: `${CG}Trust`,
      Federation: `${CG}Federation`,
      Causal: `${CG}Causal`,
      Projection: `${CG}Projection`
    };
    CGCompositionOp = {
      union: `${CG}union`,
      intersection: `${CG}intersection`,
      restriction: `${CG}restriction`,
      override: `${CG}override`
    };
    CGModalStatus = {
      Asserted: `${CG}Asserted`,
      Hypothetical: `${CG}Hypothetical`,
      Counterfactual: `${CG}Counterfactual`,
      Quoted: `${CG}Quoted`,
      Retracted: `${CG}Retracted`
    };
    CGTrustLevel = {
      SelfAsserted: `${CG}SelfAsserted`,
      ThirdPartyAttested: `${CG}ThirdPartyAttested`,
      CryptographicallyVerified: `${CG}CryptographicallyVerified`
    };
    CGAgentRole = {
      Author: `${CG}Author`,
      Curator: `${CG}Curator`,
      Validator: `${CG}Validator`
    };
    CGSyncProtocol = {
      SolidNotifications: `${CG}SolidNotifications`,
      WebSub: `${CG}WebSub`,
      LinkedDataNotifications: `${CG}LinkedDataNotifications`,
      Polling: `${CG}Polling`
    };
  }
});

// ../interego-native88/packages/core/src/rdf/turtle-parser.ts
function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "	" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    const startPos = i;
    if (src.startsWith("<<(", i)) {
      i += 3;
      out.push({ type: "punct", value: "<<(", pos: startPos });
      continue;
    }
    if (src.startsWith(")>>", i)) {
      i += 3;
      out.push({ type: "punct", value: ")>>", pos: startPos });
      continue;
    }
    if (src.startsWith("<<", i)) {
      i += 2;
      out.push({ type: "punct", value: "<<", pos: startPos });
      continue;
    }
    if (src.startsWith(">>", i)) {
      i += 2;
      out.push({ type: "punct", value: ">>", pos: startPos });
      continue;
    }
    if (src.startsWith("{|", i)) {
      i += 2;
      out.push({ type: "punct", value: "{|", pos: startPos });
      continue;
    }
    if (src.startsWith("|}", i)) {
      i += 2;
      out.push({ type: "punct", value: "|}", pos: startPos });
      continue;
    }
    if (c === "~") {
      i++;
      out.push({ type: "punct", value: "~", pos: startPos });
      continue;
    }
    if (c === "<") {
      i++;
      let value2 = "";
      while (i < n && src[i] !== ">") {
        if (src[i] === "\\" && i + 1 < n) {
          value2 += src[i] + src[i + 1];
          i += 2;
        } else {
          value2 += src[i];
          i++;
        }
      }
      if (i >= n) throw new ParseError("unterminated IRI", startPos);
      i++;
      out.push({ type: "iri", value: value2, pos: startPos });
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      const qqq = q + q + q;
      let value2 = "";
      let triple = false;
      let closed = false;
      if (src.slice(i, i + 3) === qqq) {
        triple = true;
        i += 3;
      } else {
        i++;
      }
      while (i < n) {
        if (triple) {
          if (src.slice(i, i + 3) === qqq) {
            i += 3;
            closed = true;
            break;
          }
        } else {
          if (src[i] === q) {
            i++;
            closed = true;
            break;
          }
          if (src[i] === "\n" || src[i] === "\r") {
            throw new ParseError("unterminated single-line string", startPos);
          }
        }
        if (src[i] === "\\" && i + 1 < n) {
          const esc = src[i + 1];
          const hex = (len) => {
            const digits = src.slice(i + 2, i + 2 + len);
            if (digits.length !== len || !/^[0-9A-Fa-f]+$/.test(digits)) return void 0;
            return digits;
          };
          switch (esc) {
            case "t":
              value2 += "	";
              break;
            case "n":
              value2 += "\n";
              break;
            case "r":
              value2 += "\r";
              break;
            case "f":
              value2 += String.fromCharCode(12);
              break;
            case "b":
              value2 += String.fromCharCode(8);
              break;
            case '"':
              value2 += '"';
              break;
            case "'":
              value2 += "'";
              break;
            case "\\":
              value2 += "\\";
              break;
            case "u": {
              const d = hex(4);
              if (d === void 0) {
                value2 += esc;
                break;
              }
              value2 += fromCodePointChecked(parseInt(d, 16), startPos);
              i += 4;
              break;
            }
            case "U": {
              const d = hex(8);
              if (d === void 0) {
                value2 += esc;
                break;
              }
              value2 += fromCodePointChecked(parseInt(d, 16), startPos);
              i += 8;
              break;
            }
            default:
              value2 += esc;
          }
          i += 2;
        } else {
          value2 += src[i];
          i++;
        }
      }
      if (!closed) throw new ParseError("unterminated string at EOF", startPos);
      out.push(triple ? { type: "string", value: value2, pos: startPos, triple: true } : { type: "string", value: value2, pos: startPos });
      continue;
    }
    if (c === "." || c === ";" || c === "," || c === "[" || c === "]" || c === "{" || c === "}" || c === "(" || c === ")") {
      i++;
      out.push({ type: "punct", value: c, pos: startPos });
      continue;
    }
    if (c === "^" && src[i + 1] === "^") {
      i += 2;
      out.push({ type: "punct", value: "^^", pos: startPos });
      continue;
    }
    if (c === "@") {
      i++;
      let id = "";
      while (i < n && /[A-Za-z0-9-]/.test(src[i])) {
        id += src[i];
        i++;
      }
      if (id === "prefix" || id === "base" || id === "version") {
        out.push({ type: "keyword", value: id, pos: startPos });
      } else {
        const sep = id.indexOf("--");
        if (sep !== -1) {
          const dir = id.slice(sep + 2);
          if (dir !== "ltr" && dir !== "rtl") {
            throw new ParseError(
              `base direction "${dir}" is not defined; RDF 1.2 permits only --ltr and --rtl, in lower case`,
              startPos
            );
          }
        }
        out.push({ type: "lang", value: id, pos: startPos });
      }
      continue;
    }
    if (c === "_" && src[i + 1] === ":") {
      i += 2;
      let id = "";
      while (i < n && /[A-Za-z0-9_-]/.test(src[i])) {
        id += src[i];
        i++;
      }
      out.push({ type: "bnode", id, pos: startPos });
      continue;
    }
    if (c === "-" || c === "+" || c >= "0" && c <= "9") {
      let s = "";
      if (c === "-" || c === "+") {
        s += c;
        i++;
      }
      let sawDigit = false;
      while (i < n && src[i] >= "0" && src[i] <= "9") {
        s += src[i];
        i++;
        sawDigit = true;
      }
      if (src[i] === "." && i + 1 < n && src[i + 1] >= "0" && src[i + 1] <= "9") {
        s += ".";
        i++;
        while (i < n && src[i] >= "0" && src[i] <= "9") {
          s += src[i];
          i++;
        }
      }
      if (src[i] === "e" || src[i] === "E") {
        s += src[i];
        i++;
        if (src[i] === "+" || src[i] === "-") {
          s += src[i];
          i++;
        }
        while (i < n && src[i] >= "0" && src[i] <= "9") {
          s += src[i];
          i++;
        }
      }
      if (!sawDigit) {
        i = startPos;
      } else {
        out.push({ type: "number", value: s, pos: startPos });
        continue;
      }
    }
    const idStart = /[A-Za-z_]/;
    const idCont = /[A-Za-z0-9_.-]/;
    if (idStart.test(c) || c === ":") {
      let prefix = "";
      let local = "";
      if (c !== ":") {
        while (i < n && idCont.test(src[i])) {
          prefix += src[i];
          i++;
        }
      }
      if (src[i] === ":") {
        i++;
        while (i < n && (idCont.test(src[i]) || src[i] === "%" || src[i] === "/")) {
          local += src[i];
          i++;
        }
        while (local.endsWith(".")) {
          local = local.slice(0, -1);
          i--;
        }
        out.push({ type: "pname", prefix, local, pos: startPos });
        continue;
      }
      if (prefix === "a") {
        out.push({ type: "keyword", value: "a", pos: startPos });
        continue;
      }
      if (prefix === "true") {
        out.push({ type: "boolean", value: true, pos: startPos });
        continue;
      }
      if (prefix === "false") {
        out.push({ type: "boolean", value: false, pos: startPos });
        continue;
      }
      const upper = prefix.toUpperCase();
      if (upper === "PREFIX" || upper === "BASE") {
        out.push({ type: "keyword", value: `sparql-${upper.toLowerCase()}`, pos: startPos });
        continue;
      }
      if (upper === "VERSION") {
        out.push({ type: "keyword", value: "sparql-version", pos: startPos });
        continue;
      }
      if (prefix === "GRAPH" || prefix === "graph" || prefix === "Graph") {
        out.push({ type: "keyword", value: "GRAPH", pos: startPos });
        continue;
      }
      throw new ParseError(`unknown bareword "${prefix}"`, startPos);
    }
    throw new ParseError(`unexpected character '${c}'`, startPos);
  }
  return out;
}
function describeTok(t) {
  switch (t.type) {
    case "pname":
      return `pname/${t.prefix}:${t.local}`;
    case "bnode":
      return `bnode/${t.id}`;
    default:
      return `${t.type}/${String(t.value)}`;
  }
}
function resolveIri(ref, base) {
  if (base === void 0) return ref;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref)) return ref;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:)(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(base);
  if (!m) return ref;
  const [, scheme, authority = "", basePath = "", baseQuery = ""] = m;
  if (ref === "") return `${scheme}${authority}${basePath}${baseQuery}`;
  if (ref.startsWith("#")) return `${scheme}${authority}${basePath}${baseQuery}${ref}`;
  if (ref.startsWith("//")) return `${scheme}${ref}`;
  const hash = ref.indexOf("#");
  const frag = hash === -1 ? "" : ref.slice(hash);
  const noFrag = hash === -1 ? ref : ref.slice(0, hash);
  const q = noFrag.indexOf("?");
  const query = q === -1 ? "" : noFrag.slice(q);
  const refPath = q === -1 ? noFrag : noFrag.slice(0, q);
  if (refPath === "") return `${scheme}${authority}${basePath}${query || baseQuery}${frag}`;
  const merged = refPath.startsWith("/") ? refPath : basePath.slice(0, basePath.lastIndexOf("/") + 1) + refPath;
  const out = [];
  for (const seg of merged.split("/")) {
    if (seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  let path = out.join("/");
  if (/(^|\/)\.\.?$/.test(merged) && !path.endsWith("/")) path += "/";
  if (authority !== "" && path !== "" && !path.startsWith("/")) path = `/${path}`;
  return `${scheme}${authority}${path}${query}${frag}`;
}
function peek(s, offset = 0) {
  return s.tokens[s.index + offset];
}
function consume(s) {
  const t = s.tokens[s.index++];
  if (t?.type === "iri" && s.base !== void 0) {
    const resolved = resolveIri(t.value, s.base);
    return resolved === t.value ? t : { type: "iri", value: resolved, pos: t.pos };
  }
  return t;
}
function expectPunct(s, value2) {
  const t = consume(s);
  if (!t || t.type !== "punct" || t.value !== value2) {
    throw new ParseError(`expected '${value2}', got ${t ? describeTok(t) : "EOF"}`, t?.pos ?? -1);
  }
}
function resolvePrefixed(s, prefix, local) {
  const base = s.prefixes.get(prefix);
  if (base === void 0) {
    throw new ParseError(`unknown prefix "${prefix}:"`, -1);
  }
  return canonicalize(base + local);
}
function parseTripleTerm(s) {
  const open = consume(s);
  if (s.depth >= MAX_NESTING_DEPTH) {
    throw new ParseError(
      `maximum nesting depth (${MAX_NESTING_DEPTH}) exceeded \u2014 refusing deeply-nested triple terms`,
      open?.pos ?? -1
    );
  }
  s.depth++;
  try {
    const subjTok = peek(s);
    refuseCompoundTerm(s, "subject inside << >> or <<( )>>");
    const subject = parseTermAsTerm(s);
    if (subject.kind !== "iri" && subject.kind !== "bnode") {
      throw new ParseError(
        "a triple term subject must be an IRI or blank node (RDF 1.2 Turtle [33] ttSubject)",
        subjTok?.pos ?? -1
      );
    }
    const predicate = parsePredicate(s);
    refuseCompoundTerm(s, "object inside << >> or <<( )>>");
    const object2 = parseTermAsTerm(s);
    const close = peek(s);
    if (!(close?.type === "punct" && close.value === ")>>")) {
      throw new ParseError("expected ')>>' to close a triple term", close?.pos ?? -1);
    }
    consume(s);
    return { kind: "triple", subject, predicate, object: object2 };
  } finally {
    s.depth--;
  }
}
function fromCodePointChecked(cp, pos) {
  const hexed = cp.toString(16).toUpperCase();
  if (cp > 1114111) {
    throw new ParseError(`numeric escape ${hexed} is beyond the Unicode range`, pos);
  }
  if (cp >= 55296 && cp <= 57343) {
    throw new ParseError(
      `numeric escape ${hexed} is a surrogate code point, which is not a character; write a supplementary character as one 8-hex escape`,
      pos
    );
  }
  return String.fromCodePoint(cp);
}
function refuseCompoundTerm(s, position) {
  const nx = peek(s);
  if (nx?.type === "punct" && nx.value === "(") {
    throw new ParseError(
      `a ${position} may not be a collection: it expands to triples of its own, and this construct names exactly one (RDF 1.2 Turtle [30]/[31], [33]/[34])`,
      nx.pos
    );
  }
  if (nx?.type === "punct" && nx.value === "[") {
    const after = peek(s, 1);
    const empty = after?.type === "punct" && after.value === "]";
    if (!empty) {
      throw new ParseError(
        `a ${position} may not be a blank-node property list; an empty [] is permitted (RDF 1.2 Turtle [30]/[31], [33]/[34])`,
        nx.pos
      );
    }
  }
}
function parseReifiedTriple(s) {
  const open = consume(s);
  if (s.depth >= MAX_NESTING_DEPTH) {
    throw new ParseError(
      `maximum nesting depth (${MAX_NESTING_DEPTH}) exceeded \u2014 refusing deeply-nested reified triples`,
      open?.pos ?? -1
    );
  }
  s.depth++;
  try {
    const subjTok = peek(s);
    refuseCompoundTerm(s, "subject inside << >> or <<( )>>");
    const subject = parseTermAsTerm(s);
    if (subject.kind !== "iri" && subject.kind !== "bnode") {
      throw new ParseError(
        "a reified-triple subject must be an IRI, blank node or nested reified triple (RDF 1.2 Turtle [30] rtSubject)",
        subjTok?.pos ?? -1
      );
    }
    const predicate = parsePredicate(s);
    refuseCompoundTerm(s, "object inside << >> or <<( )>>");
    const object2 = parseTermAsTerm(s);
    let reifier;
    const next = peek(s);
    if (next?.type === "punct" && next.value === "~") {
      consume(s);
      const after = peek(s);
      if (after && (after.type === "iri" || after.type === "pname" || after.type === "bnode")) {
        reifier = parseTermAsTerm(s);
      } else {
        reifier = { kind: "bnode", id: `_anon${s.bnodeCounter++}` };
      }
    } else {
      reifier = { kind: "bnode", id: `_anon${s.bnodeCounter++}` };
    }
    const close = peek(s);
    if (!(close?.type === "punct" && close.value === ">>")) {
      throw new ParseError("expected '>>' to close a reified triple", close?.pos ?? -1);
    }
    consume(s);
    emitReifier(s, reifier, subject, predicate, object2);
    return reifier;
  } finally {
    s.depth--;
  }
}
function parseTermAsTerm(s) {
  const t = peek(s);
  if (!t) throw new ParseError("expected term, got EOF", -1);
  if (t.type === "iri") {
    const c = consume(s);
    return { kind: "iri", iri: c.value };
  }
  if (t.type === "pname") {
    consume(s);
    return { kind: "iri", iri: resolvePrefixed(s, t.prefix, t.local) };
  }
  if (t.type === "bnode") {
    consume(s);
    return { kind: "bnode", id: t.id };
  }
  if (t.type === "punct" && t.value === "<<(") {
    return parseTripleTerm(s);
  }
  if (t.type === "punct" && t.value === "<<") {
    return parseReifiedTriple(s);
  }
  if (t.type === "string") {
    consume(s);
    let datatype;
    let language;
    const next = peek(s);
    if (next?.type === "punct" && next.value === "^^") {
      consume(s);
      const dt = consume(s);
      if (!dt) throw new ParseError("expected datatype IRI after ^^", t.pos);
      if (dt.type === "iri") datatype = dt.value;
      else if (dt.type === "pname") datatype = resolvePrefixed(s, dt.prefix, dt.local);
      else throw new ParseError("expected IRI for datatype", dt.pos);
    } else if (next?.type === "lang") {
      consume(s);
      language = next.value;
    }
    return { kind: "literal", value: t.value, datatype, language };
  }
  if (t.type === "number") {
    consume(s);
    const dt = /[eE]/.test(t.value) ? "http://www.w3.org/2001/XMLSchema#double" : t.value.includes(".") ? "http://www.w3.org/2001/XMLSchema#decimal" : "http://www.w3.org/2001/XMLSchema#integer";
    return { kind: "literal", value: t.value, datatype: dt };
  }
  if (t.type === "boolean") {
    consume(s);
    return { kind: "literal", value: t.value ? "true" : "false", datatype: "http://www.w3.org/2001/XMLSchema#boolean" };
  }
  if (t.type === "punct" && t.value === "[") {
    consume(s);
    if (s.depth >= MAX_NESTING_DEPTH) {
      throw new ParseError(`maximum nesting depth (${MAX_NESTING_DEPTH}) exceeded \u2014 refusing deeply-nested blank-node input that would otherwise blow the JS stack`, t.pos);
    }
    s.depth++;
    const id = `_anon${s.bnodeCounter++}`;
    const props = /* @__PURE__ */ new Map();
    s.bnodeProperties.set(id, props);
    parsePropertyList(s, props, { kind: "bnode", id });
    s.depth--;
    expectPunct(s, "]");
    return { kind: "bnode", id };
  }
  if (t.type === "punct" && t.value === "(") {
    return parseCollection(s);
  }
  throw new ParseError(`unexpected token type "${t.type}"`, t.pos);
}
function parseCollection(s) {
  const openTok = consume(s);
  if (s.depth >= MAX_NESTING_DEPTH) {
    throw new ParseError(`maximum nesting depth (${MAX_NESTING_DEPTH}) exceeded \u2014 refusing deeply-nested collection input`, openTok?.pos ?? -1);
  }
  s.depth++;
  const items = [];
  while (true) {
    const next = peek(s);
    if (!next) throw new ParseError("unterminated collection \u2014 missing `)`", openTok?.pos ?? -1);
    if (next.type === "punct" && next.value === ")") {
      consume(s);
      break;
    }
    items.push(parseTermAsTerm(s));
  }
  s.depth--;
  if (items.length === 0) return { kind: "iri", iri: RDF_NIL };
  let rest = { kind: "iri", iri: RDF_NIL };
  for (let i = items.length - 1; i >= 0; i--) {
    const cellId = `_anon${s.bnodeCounter++}`;
    const cellProps = /* @__PURE__ */ new Map();
    cellProps.set(RDF_FIRST, [items[i]]);
    cellProps.set(RDF_REST, [rest]);
    s.bnodeProperties.set(cellId, cellProps);
    rest = { kind: "bnode", id: cellId };
  }
  return rest;
}
function parsePredicate(s) {
  const t = consume(s);
  if (!t) throw new ParseError("expected predicate, got EOF", -1);
  if (t.type === "iri") return t.value;
  if (t.type === "pname") return resolvePrefixed(s, t.prefix, t.local);
  if (t.type === "keyword" && t.value === "a") return RDF_TYPE;
  throw new ParseError(`expected predicate, got ${t.type}`, t.pos);
}
function parseSubject(s) {
  const t = peek(s);
  if (!t) throw new ParseError("expected subject", -1);
  if (t.type === "iri") {
    const c = consume(s);
    const key = c.value;
    if (!s.subjects.has(key)) s.subjects.set(key, /* @__PURE__ */ new Map());
    return { key, props: s.subjects.get(key) };
  }
  if (t.type === "pname") {
    consume(s);
    const key = resolvePrefixed(s, t.prefix, t.local);
    if (!s.subjects.has(key)) s.subjects.set(key, /* @__PURE__ */ new Map());
    return { key, props: s.subjects.get(key) };
  }
  if (t.type === "bnode") {
    consume(s);
    const key = `_:${t.id}`;
    if (!s.subjects.has(key)) s.subjects.set(key, /* @__PURE__ */ new Map());
    return { key, props: s.subjects.get(key) };
  }
  if (t.type === "punct" && t.value === "[") {
    consume(s);
    if (s.depth >= MAX_NESTING_DEPTH) {
      throw new ParseError(`maximum nesting depth (${MAX_NESTING_DEPTH}) exceeded \u2014 refusing deeply-nested blank-node input that would otherwise blow the JS stack`, t.pos);
    }
    s.depth++;
    const id = `_anon${s.bnodeCounter++}`;
    const key = `_:${id}`;
    const props = /* @__PURE__ */ new Map();
    s.subjects.set(key, props);
    parsePropertyList(s, props, { kind: "bnode", id });
    s.depth--;
    expectPunct(s, "]");
    return { key, props };
  }
  if (t.type === "punct" && t.value === "(") {
    const head = parseCollection(s);
    if (head.kind === "iri") {
      const key2 = head.iri;
      if (!s.subjects.has(key2)) s.subjects.set(key2, /* @__PURE__ */ new Map());
      return { key: key2, props: s.subjects.get(key2) };
    }
    if (head.kind !== "bnode") {
      throw new ParseError("internal: subject-position collection returned non-bnode head", t.pos);
    }
    const key = `_:${head.id}`;
    const existing = s.bnodeProperties.get(head.id);
    const props = existing ?? /* @__PURE__ */ new Map();
    s.subjects.set(key, props);
    return { key, props };
  }
  if (t.type === "punct" && t.value === "<<") {
    const reifier = parseReifiedTriple(s);
    const key = reifier.kind === "iri" ? reifier.iri : reifier.kind === "bnode" ? `_:${reifier.id}` : void 0;
    if (key === void 0) {
      throw new ParseError("internal: reified triple did not yield a reifier node", t.pos);
    }
    if (!s.subjects.has(key)) s.subjects.set(key, /* @__PURE__ */ new Map());
    return { key, props: s.subjects.get(key) };
  }
  throw new ParseError(`expected subject, got ${t.type}`, t.pos);
}
function parseAnnotation(s, subject, predicate, object2) {
  let pendingReifier;
  let sawAny = false;
  while (true) {
    const next = peek(s);
    if (!next || next.type !== "punct") break;
    if (next.value === "~") {
      consume(s);
      sawAny = true;
      const after = peek(s);
      if (after && (after.type === "iri" || after.type === "pname" || after.type === "bnode")) {
        const term = parseTermAsTerm(s);
        pendingReifier = term;
      } else {
        pendingReifier = { kind: "bnode", id: `_anon${s.bnodeCounter++}` };
      }
      emitReifier(s, pendingReifier, subject, predicate, object2);
      continue;
    }
    if (next.value === "{|") {
      consume(s);
      sawAny = true;
      const reifier = pendingReifier ?? { kind: "bnode", id: `_anon${s.bnodeCounter++}` };
      if (pendingReifier === void 0) emitReifier(s, reifier, subject, predicate, object2);
      const props = reifierProps(s, reifier);
      parsePropertyList(s, props, reifier);
      const close = peek(s);
      if (!(close?.type === "punct" && close.value === "|}")) {
        throw new ParseError("expected '|}' to close an annotation block", close?.pos ?? -1);
      }
      consume(s);
      pendingReifier = void 0;
      continue;
    }
    break;
  }
  void sawAny;
}
function reifierProps(s, reifier) {
  if (reifier.kind === "iri") {
    const existing2 = s.subjects.get(reifier.iri);
    if (existing2) return existing2;
    const fresh2 = /* @__PURE__ */ new Map();
    s.subjects.set(reifier.iri, fresh2);
    return fresh2;
  }
  const existing = s.bnodeProperties.get(reifier.id);
  if (existing) return existing;
  const fresh = /* @__PURE__ */ new Map();
  s.bnodeProperties.set(reifier.id, fresh);
  return fresh;
}
function emitReifier(s, reifier, subject, predicate, object2) {
  const props = reifierProps(s, reifier);
  const tt = { kind: "triple", subject, predicate, object: object2 };
  const list = props.get(RDF_REIFIES);
  if (list) list.push(tt);
  else props.set(RDF_REIFIES, [tt]);
}
function parsePropertyList(s, props, subject) {
  while (true) {
    const next = peek(s);
    if (!next) return;
    if (next.type === "punct" && (next.value === "]" || next.value === "." || next.value === "}" || next.value === "|}")) return;
    if (next.type === "punct" && next.value === ";") {
      consume(s);
      continue;
    }
    const predicate = parsePredicate(s);
    while (true) {
      const term = parseTermAsTerm(s);
      const list = props.get(predicate);
      if (list) list.push(term);
      else props.set(predicate, [term]);
      parseAnnotation(s, subject, predicate, term);
      const after = peek(s);
      if (after?.type === "punct" && after.value === ",") {
        consume(s);
        continue;
      }
      break;
    }
  }
}
function parseTriplesBlock(s) {
  const { key, props } = parseSubject(s);
  const subjectTerm = key.startsWith("_:") ? { kind: "bnode", id: key.slice(2) } : { kind: "iri", iri: key };
  parsePropertyList(s, props, subjectTerm);
  const end = peek(s);
  if (end?.type === "punct" && end.value === ".") consume(s);
}
function parseTrig(src) {
  const tokens = tokenize(src);
  const state = {
    tokens,
    index: 0,
    prefixes: /* @__PURE__ */ new Map(),
    subjects: /* @__PURE__ */ new Map(),
    bnodeProperties: /* @__PURE__ */ new Map(),
    bnodeCounter: 0,
    depth: 0
  };
  while (state.index < tokens.length) {
    const t = peek(state);
    if (t.type === "keyword" && (t.value === "prefix" || t.value === "sparql-prefix")) {
      const wantsDot = t.value === "prefix";
      consume(state);
      const nameTok = consume(state);
      if (!nameTok || nameTok.type !== "pname") {
        throw new ParseError('expected "prefix:" after a prefix directive', nameTok?.pos ?? -1);
      }
      const iriTok = consume(state);
      if (!iriTok || iriTok.type !== "iri") {
        throw new ParseError("expected IRI for prefix value", iriTok?.pos ?? -1);
      }
      state.prefixes.set(nameTok.prefix, iriTok.value);
      if (wantsDot) {
        const dot = consume(state);
        if (!dot || dot.type !== "punct" || dot.value !== ".") {
          throw new ParseError('expected "." after @prefix declaration', dot?.pos ?? -1);
        }
      }
      continue;
    }
    if (t.type === "keyword" && (t.value === "version" || t.value === "sparql-version")) {
      consume(state);
      const lit = peek(state);
      if (lit?.type === "string" && lit.triple === true) {
        throw new ParseError(
          "the version string must be a short quoted string; the triple-quoted forms are not permitted here (Turtle 1.2 [4a])",
          lit.pos
        );
      }
      if (lit?.type === "string") consume(state);
      if (t.value === "version") {
        const dot = peek(state);
        if (dot?.type === "punct" && dot.value === ".") consume(state);
      }
      continue;
    }
    if (t.type === "keyword" && (t.value === "base" || t.value === "sparql-base")) {
      consume(state);
      const iriTok = peek(state);
      if (iriTok?.type === "iri") {
        const resolvedBase = consume(state);
        if (resolvedBase?.type === "iri") state.base = resolvedBase.value;
      }
      const dot = peek(state);
      if (dot?.type === "punct" && dot.value === ".") consume(state);
      continue;
    }
    if (t.type === "iri" || t.type === "pname") {
      const next = peek(state, 1);
      if (next?.type === "punct" && next.value === "{") {
        consume(state);
        consume(state);
        for (; ; ) {
          const inner = peek(state);
          if (!inner || inner.type === "punct" && inner.value === "}") break;
          parseTriplesBlock(state);
        }
        expectPunct(state, "}");
        continue;
      }
    }
    if (t.type === "keyword" && t.value === "GRAPH") {
      consume(state);
      const graphName = peek(state);
      if (graphName?.type === "iri" || graphName?.type === "pname") {
        consume(state);
      }
      expectPunct(state, "{");
      for (; ; ) {
        const inner = peek(state);
        if (!inner || inner.type === "punct" && inner.value === "}") break;
        parseTriplesBlock(state);
      }
      expectPunct(state, "}");
      continue;
    }
    parseTriplesBlock(state);
  }
  const subjects = [];
  for (const [key, properties] of state.subjects) {
    const subject = key.startsWith("_:") ? { bnode: key.slice(2) } : key;
    subjects.push({ subject, properties });
  }
  for (const [id, properties] of state.bnodeProperties) {
    subjects.push({ subject: { bnode: id }, properties });
  }
  return { prefixes: state.prefixes, subjects };
}
var RDF_TYPE, RDF_FIRST, RDF_REST, RDF_NIL, ParseError, MAX_NESTING_DEPTH, RDF_REIFIES;
var init_turtle_parser = __esm({
  "../interego-native88/packages/core/src/rdf/turtle-parser.ts"() {
    "use strict";
    init_namespaces();
    RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    RDF_FIRST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#first";
    RDF_REST = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";
    RDF_NIL = "http://www.w3.org/1999/02/22-rdf-syntax-ns#nil";
    ParseError = class extends Error {
      constructor(message, position) {
        super(`${message} at offset ${position}`);
        this.position = position;
        this.name = "ParseError";
      }
      position;
    };
    MAX_NESTING_DEPTH = 256;
    RDF_REIFIES = "http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies";
  }
});

// ../interego-native88/packages/core/src/rdf/graph-digest.ts
var init_graph_digest = __esm({
  "../interego-native88/packages/core/src/rdf/graph-digest.ts"() {
    "use strict";
    init_turtle_parser();
  }
});

// ../interego-native88/packages/core/src/rdf/escape.ts
function turtleIriRef(value2) {
  if (typeof value2 !== "string" || value2.length === 0) return null;
  if (IRIREF_FORBIDDEN.test(value2)) return null;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value2)) return null;
  return `<${value2}>`;
}
var IRIREF_FORBIDDEN;
var init_escape = __esm({
  "../interego-native88/packages/core/src/rdf/escape.ts"() {
    "use strict";
    IRIREF_FORBIDDEN = /[\u0000- <>"{}|^`\\]/;
  }
});

// ../interego-native88/packages/core/src/model/delegation.ts
var init_delegation = __esm({
  "../interego-native88/packages/core/src/model/delegation.ts"() {
    "use strict";
    init_graph_digest();
    init_escape();
  }
});

// ../interego-native88/packages/core/src/model/delegate.ts
var init_delegate = __esm({
  "../interego-native88/packages/core/src/model/delegate.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/model/category.ts
var init_category = __esm({
  "../interego-native88/packages/core/src/model/category.ts"() {
    "use strict";
    init_composition();
  }
});

// ../interego-native88/packages/core/src/model/semiotic.ts
var init_semiotic = __esm({
  "../interego-native88/packages/core/src/model/semiotic.ts"() {
    "use strict";
    init_types();
    init_composition();
  }
});

// ../interego-native88/packages/core/src/model/derivation.ts
var init_derivation = __esm({
  "../interego-native88/packages/core/src/model/derivation.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/model/publish-preprocess.ts
var init_publish_preprocess = __esm({
  "../interego-native88/packages/core/src/model/publish-preprocess.ts"() {
    "use strict";
    init_types();
  }
});

// ../interego-native88/packages/core/src/model/index.ts
var init_model = __esm({
  "../interego-native88/packages/core/src/model/index.ts"() {
    "use strict";
    init_types();
    init_descriptor();
    init_composition();
    init_delegation();
    init_delegate();
    init_registry();
    init_category();
    init_semiotic();
    init_derivation();
    init_publish_preprocess();
  }
});

// ../interego-native88/packages/core/src/model/causality.ts
var init_causality = __esm({
  "../interego-native88/packages/core/src/model/causality.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/rdf/serializer.ts
var init_serializer = __esm({
  "../interego-native88/packages/core/src/rdf/serializer.ts"() {
    "use strict";
    init_namespaces();
  }
});

// ../interego-native88/packages/core/src/rdf/alternate-turtle.ts
var init_alternate_turtle = __esm({
  "../interego-native88/packages/core/src/rdf/alternate-turtle.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/rdf/rdf12.ts
var init_rdf12 = __esm({
  "../interego-native88/packages/core/src/rdf/rdf12.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/rdf/jsonld.ts
var init_jsonld = __esm({
  "../interego-native88/packages/core/src/rdf/jsonld.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/validation/shacl-shapes.ts
var init_shacl_shapes = __esm({
  "../interego-native88/packages/core/src/validation/shacl-shapes.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/rdf/system-ontology.ts
var init_system_ontology = __esm({
  "../interego-native88/packages/core/src/rdf/system-ontology.ts"() {
    "use strict";
    init_namespaces();
    init_shacl_shapes();
  }
});

// ../interego-native88/packages/core/src/rdf/index.ts
var init_rdf = __esm({
  "../interego-native88/packages/core/src/rdf/index.ts"() {
    "use strict";
    init_namespaces();
    init_escape();
    init_serializer();
    init_turtle_parser();
    init_alternate_turtle();
    init_graph_digest();
    init_rdf12();
    init_jsonld();
    init_system_ontology();
  }
});

// ../interego-native88/packages/core/src/validation/validator.ts
var init_validator = __esm({
  "../interego-native88/packages/core/src/validation/validator.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/validation/sparql-functions.ts
var XSD2, NUMERIC, UNKNOWN;
var init_sparql_functions = __esm({
  "../interego-native88/packages/core/src/validation/sparql-functions.ts"() {
    "use strict";
    XSD2 = "http://www.w3.org/2001/XMLSchema#";
    NUMERIC = new Set([
      "integer",
      "decimal",
      "double",
      "float",
      "long",
      "int",
      "short",
      "byte",
      "nonNegativeInteger",
      "positiveInteger",
      "nonPositiveInteger",
      "negativeInteger",
      "unsignedLong",
      "unsignedInt",
      "unsignedShort",
      "unsignedByte"
    ].map((t) => `${XSD2}${t}`));
    UNKNOWN = Object.freeze([]);
  }
});

// ../interego-native88/packages/core/src/validation/node-expression.ts
var RDF2, RDF_FIRST2, RDF_REST2, RDF_NIL2, RDF_TYPE2;
var init_node_expression = __esm({
  "../interego-native88/packages/core/src/validation/node-expression.ts"() {
    "use strict";
    init_sparql_functions();
    RDF2 = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
    RDF_FIRST2 = `${RDF2}first`;
    RDF_REST2 = `${RDF2}rest`;
    RDF_NIL2 = `${RDF2}nil`;
    RDF_TYPE2 = `${RDF2}type`;
  }
});

// ../interego-native88/packages/core/src/validation/sparql-query.ts
var XSD3, NUMERIC_DATATYPES, INSTANT_DATATYPES;
var init_sparql_query = __esm({
  "../interego-native88/packages/core/src/validation/sparql-query.ts"() {
    "use strict";
    init_sparql_functions();
    XSD3 = "http://www.w3.org/2001/XMLSchema#";
    NUMERIC_DATATYPES = /* @__PURE__ */ new Set([
      `${XSD3}integer`,
      `${XSD3}decimal`,
      `${XSD3}double`,
      `${XSD3}float`,
      `${XSD3}long`,
      `${XSD3}int`,
      `${XSD3}short`,
      `${XSD3}byte`,
      `${XSD3}nonNegativeInteger`,
      `${XSD3}nonPositiveInteger`,
      `${XSD3}negativeInteger`,
      `${XSD3}positiveInteger`,
      `${XSD3}unsignedLong`,
      `${XSD3}unsignedInt`,
      `${XSD3}unsignedShort`,
      `${XSD3}unsignedByte`
    ]);
    INSTANT_DATATYPES = /* @__PURE__ */ new Set([`${XSD3}dateTime`, `${XSD3}dateTimeStamp`]);
  }
});

// ../interego-native88/packages/core/src/validation/shacl-engine.ts
var SHACL2, XSD4, SH_NODE_SHAPE, SH_PROPERTY_SHAPE, SH_TARGET_CLASS, SH_TARGET_NODE, SH_PROPERTY, SH_BY_TYPES, SH_TARGET_WHERE, SH_SHAPE, SH_SHAPE_CLASS, SH_SOME_VALUE, SH_MEMBER_SHAPE, SH_UNIQUE_VALUES_FOR, SH_MIN_LIST_LENGTH, SH_MAX_LIST_LENGTH, SH_UNIQUE_MEMBERS, SH_SUBSET_OF, SH_ROOT_CLASS, SH_SINGLE_LINE, SH_NOT, SH_AND, SH_OR, SH_XONE, SH_PATH, SH_INVERSE_PATH, SH_ALTERNATIVE_PATH, SH_ZERO_OR_MORE_PATH, SH_ONE_OR_MORE_PATH, SH_ZERO_OR_ONE_PATH, SH_MIN_COUNT, SH_MAX_COUNT, SH_DATATYPE, SH_NODE_KIND, SH_CLASS, SH_PATTERN, SH_HAS_VALUE, SH_MESSAGE, SH_IN, SH_CLOSED, SH_SPARQL, SH_SELECT, SH_ASK, SH_PREFIXES, SH_DECLARE, SH_NAMESPACE, SH_PREFIX, SH_SHAPES_GRAPH_CLASS, SH_REIFIER_SHAPE, SH_REIFICATION_REQUIRED, SH_NODE, SH_NODE_BY_EXPRESSION, SH_EXPRESSION, SH_VALUES, SH_CONSTRAINT_COMPONENT, SH_PARAMETER, SH_OPTIONAL, SH_VALIDATOR, SH_NODE_VALIDATOR, SH_PROPERTY_VALIDATOR, SH_BODY_EXPRESSION, SH_SPARQL_EXPR, SH_QUALIFIED_VALUE_SHAPE, SH_QUALIFIED_VALUE_SHAPES_DISJOINT, SH_QUALIFIED_MIN_COUNT, SH_QUALIFIED_MAX_COUNT, SH_TARGET_SUBJECTS_OF, SH_TARGET_OBJECTS_OF, SH_DEACTIVATED, SH_SEVERITY, SH_MIN_INCLUSIVE, SH_MAX_INCLUSIVE, SH_MIN_EXCLUSIVE, SH_MAX_EXCLUSIVE, SH_MIN_LENGTH, SH_MAX_LENGTH, SH_LANGUAGE_IN, SH_UNIQUE_LANG, SH_EQUALS, SH_DISJOINT, SH_LESS_THAN, SH_LESS_THAN_OR_EQUALS, SH_IGNORED_PROPERTIES, IMPLEMENTED_SHACL_PREDICATES, NON_VALIDATING_SHACL_PREDICATES, SH_IRI, SH_LITERAL, SH_BLANK_NODE, SH_BLANK_NODE_OR_IRI, SH_BLANK_NODE_OR_LITERAL, SH_IRI_OR_LITERAL, SH_TRIPLE_TERM, NUMERIC_TYPES, TEMPORAL_TYPES, SH_RULE, SH_TRIPLE_RULE, SH_SPARQL_RULE, SH_SUBJECT, SH_PREDICATE, SH_OBJECT, SH_THIS, SH_CONSTRUCT;
var init_shacl_engine = __esm({
  "../interego-native88/packages/core/src/validation/shacl-engine.ts"() {
    "use strict";
    init_turtle_parser();
    init_escape();
    init_node_expression();
    init_sparql_query();
    SHACL2 = "http://www.w3.org/ns/shacl#";
    XSD4 = "http://www.w3.org/2001/XMLSchema#";
    SH_NODE_SHAPE = `${SHACL2}NodeShape`;
    SH_PROPERTY_SHAPE = `${SHACL2}PropertyShape`;
    SH_TARGET_CLASS = `${SHACL2}targetClass`;
    SH_TARGET_NODE = `${SHACL2}targetNode`;
    SH_PROPERTY = `${SHACL2}property`;
    SH_BY_TYPES = `${SHACL2}ByTypes`;
    SH_TARGET_WHERE = `${SHACL2}targetWhere`;
    SH_SHAPE = `${SHACL2}shape`;
    SH_SHAPE_CLASS = `${SHACL2}ShapeClass`;
    SH_SOME_VALUE = `${SHACL2}someValue`;
    SH_MEMBER_SHAPE = `${SHACL2}memberShape`;
    SH_UNIQUE_VALUES_FOR = `${SHACL2}uniqueValuesFor`;
    SH_MIN_LIST_LENGTH = `${SHACL2}minListLength`;
    SH_MAX_LIST_LENGTH = `${SHACL2}maxListLength`;
    SH_UNIQUE_MEMBERS = `${SHACL2}uniqueMembers`;
    SH_SUBSET_OF = `${SHACL2}subsetOf`;
    SH_ROOT_CLASS = `${SHACL2}rootClass`;
    SH_SINGLE_LINE = `${SHACL2}singleLine`;
    SH_NOT = `${SHACL2}not`;
    SH_AND = `${SHACL2}and`;
    SH_OR = `${SHACL2}or`;
    SH_XONE = `${SHACL2}xone`;
    SH_PATH = `${SHACL2}path`;
    SH_INVERSE_PATH = `${SHACL2}inversePath`;
    SH_ALTERNATIVE_PATH = `${SHACL2}alternativePath`;
    SH_ZERO_OR_MORE_PATH = `${SHACL2}zeroOrMorePath`;
    SH_ONE_OR_MORE_PATH = `${SHACL2}oneOrMorePath`;
    SH_ZERO_OR_ONE_PATH = `${SHACL2}zeroOrOnePath`;
    SH_MIN_COUNT = `${SHACL2}minCount`;
    SH_MAX_COUNT = `${SHACL2}maxCount`;
    SH_DATATYPE = `${SHACL2}datatype`;
    SH_NODE_KIND = `${SHACL2}nodeKind`;
    SH_CLASS = `${SHACL2}class`;
    SH_PATTERN = `${SHACL2}pattern`;
    SH_HAS_VALUE = `${SHACL2}hasValue`;
    SH_MESSAGE = `${SHACL2}message`;
    SH_IN = `${SHACL2}in`;
    SH_CLOSED = `${SHACL2}closed`;
    SH_SPARQL = `${SHACL2}sparql`;
    SH_SELECT = `${SHACL2}select`;
    SH_ASK = `${SHACL2}ask`;
    SH_PREFIXES = `${SHACL2}prefixes`;
    SH_DECLARE = `${SHACL2}declare`;
    SH_NAMESPACE = `${SHACL2}namespace`;
    SH_PREFIX = `${SHACL2}prefix`;
    SH_SHAPES_GRAPH_CLASS = `${SHACL2}ShapesGraph`;
    SH_REIFIER_SHAPE = `${SHACL2}reifierShape`;
    SH_REIFICATION_REQUIRED = `${SHACL2}reificationRequired`;
    SH_NODE = `${SHACL2}node`;
    SH_NODE_BY_EXPRESSION = `${SHACL2}nodeByExpression`;
    SH_EXPRESSION = `${SHACL2}expression`;
    SH_VALUES = `${SHACL2}values`;
    SH_CONSTRAINT_COMPONENT = `${SHACL2}ConstraintComponent`;
    SH_PARAMETER = `${SHACL2}parameter`;
    SH_OPTIONAL = `${SHACL2}optional`;
    SH_VALIDATOR = `${SHACL2}validator`;
    SH_NODE_VALIDATOR = `${SHACL2}nodeValidator`;
    SH_PROPERTY_VALIDATOR = `${SHACL2}propertyValidator`;
    SH_BODY_EXPRESSION = `${SHACL2}bodyExpression`;
    SH_SPARQL_EXPR = `${SHACL2}sparqlExpr`;
    SH_QUALIFIED_VALUE_SHAPE = `${SHACL2}qualifiedValueShape`;
    SH_QUALIFIED_VALUE_SHAPES_DISJOINT = `${SHACL2}qualifiedValueShapesDisjoint`;
    SH_QUALIFIED_MIN_COUNT = `${SHACL2}qualifiedMinCount`;
    SH_QUALIFIED_MAX_COUNT = `${SHACL2}qualifiedMaxCount`;
    SH_TARGET_SUBJECTS_OF = `${SHACL2}targetSubjectsOf`;
    SH_TARGET_OBJECTS_OF = `${SHACL2}targetObjectsOf`;
    SH_DEACTIVATED = `${SHACL2}deactivated`;
    SH_SEVERITY = `${SHACL2}severity`;
    SH_MIN_INCLUSIVE = `${SHACL2}minInclusive`;
    SH_MAX_INCLUSIVE = `${SHACL2}maxInclusive`;
    SH_MIN_EXCLUSIVE = `${SHACL2}minExclusive`;
    SH_MAX_EXCLUSIVE = `${SHACL2}maxExclusive`;
    SH_MIN_LENGTH = `${SHACL2}minLength`;
    SH_MAX_LENGTH = `${SHACL2}maxLength`;
    SH_LANGUAGE_IN = `${SHACL2}languageIn`;
    SH_UNIQUE_LANG = `${SHACL2}uniqueLang`;
    SH_EQUALS = `${SHACL2}equals`;
    SH_DISJOINT = `${SHACL2}disjoint`;
    SH_LESS_THAN = `${SHACL2}lessThan`;
    SH_LESS_THAN_OR_EQUALS = `${SHACL2}lessThanOrEquals`;
    SH_IGNORED_PROPERTIES = `${SHACL2}ignoredProperties`;
    IMPLEMENTED_SHACL_PREDICATES = /* @__PURE__ */ new Set([
      // targets
      SH_TARGET_CLASS,
      SH_TARGET_NODE,
      SH_TARGET_SUBJECTS_OF,
      SH_TARGET_OBJECTS_OF,
      // property paths (SHACL 2.3) — these are path SYNTAX, not constraints, and reporting
      // them as unimplemented after implementing them would be its own false claim.
      SH_INVERSE_PATH,
      SH_ALTERNATIVE_PATH,
      SH_ZERO_OR_MORE_PATH,
      SH_ONE_OR_MORE_PATH,
      SH_ZERO_OR_ONE_PATH,
      // structure
      SH_PROPERTY,
      SH_PATH,
      SH_NODE,
      SH_QUALIFIED_VALUE_SHAPE,
      SH_NOT,
      SH_AND,
      SH_OR,
      SH_XONE,
      // SHACL 1.2 constraint components
      SH_SOME_VALUE,
      SH_MEMBER_SHAPE,
      SH_MIN_LIST_LENGTH,
      SH_MAX_LIST_LENGTH,
      SH_UNIQUE_MEMBERS,
      SH_SUBSET_OF,
      SH_ROOT_CLASS,
      SH_SINGLE_LINE,
      SH_TARGET_WHERE,
      SH_SHAPE,
      SH_REIFIER_SHAPE,
      SH_REIFICATION_REQUIRED,
      // ★ sh:sparql IS IMPLEMENTED NOW, so it must leave this sweep. Reporting an implemented
      // constraint as unsupported would pin `fullyChecked: false` on every graph the shape
      // selects, which is the same false claim as the reverse — the flag would say a check was
      // skipped when it ran. sh:select / sh:ask / sh:prefixes / sh:declare and the prefix
      // vocabulary are the constraint's INTERIOR and were already exempt.
      SH_SPARQL,
      SH_SELECT,
      SH_ASK,
      SH_PREFIXES,
      SH_DECLARE,
      SH_NAMESPACE,
      SH_PREFIX,
      SH_VALUES,
      // SPARQL-based constraint components: the shapes graph declares a new constraint kind
      // and the engine runs it, so reporting the vocabulary as unsupported would pin
      // fullyChecked:false on every graph a component touches.
      SH_PARAMETER,
      SH_OPTIONAL,
      SH_VALIDATOR,
      SH_NODE_VALIDATOR,
      SH_PROPERTY_VALIDATOR,
      // sh:function bodies. sh:sparqlExpr is evaluated as a bare expression inside one.
      SH_BODY_EXPRESSION,
      SH_SPARQL_EXPR,
      SH_QUALIFIED_MIN_COUNT,
      SH_QUALIFIED_MAX_COUNT,
      SH_CLOSED,
      SH_IGNORED_PROPERTIES,
      SH_DEACTIVATED,
      SH_SEVERITY,
      SH_MESSAGE,
      // cardinality + value type
      SH_MIN_COUNT,
      SH_MAX_COUNT,
      SH_DATATYPE,
      SH_NODE_KIND,
      SH_CLASS,
      // value range
      SH_MIN_INCLUSIVE,
      SH_MAX_INCLUSIVE,
      SH_MIN_EXCLUSIVE,
      SH_MAX_EXCLUSIVE,
      // string
      SH_MIN_LENGTH,
      SH_MAX_LENGTH,
      SH_PATTERN,
      SH_LANGUAGE_IN,
      SH_UNIQUE_LANG,
      // value enumeration
      SH_IN,
      SH_HAS_VALUE,
      // property pairs
      SH_EQUALS,
      SH_DISJOINT,
      SH_LESS_THAN,
      SH_LESS_THAN_OR_EQUALS,
      // SHACL-AF rules — executed by runShaclRules, which refuses every form it cannot run
      `${SHACL2}rule`,
      `${SHACL2}subject`,
      `${SHACL2}predicate`,
      `${SHACL2}object`
    ]);
    NON_VALIDATING_SHACL_PREDICATES = /* @__PURE__ */ new Set([
      `${SHACL2}name`,
      `${SHACL2}description`,
      `${SHACL2}order`,
      `${SHACL2}group`,
      `${SHACL2}defaultValue`,
      `${SHACL2}labelTemplate`,
      `${SHACL2}select`,
      `${SHACL2}ask`,
      `${SHACL2}prefixes`,
      `${SHACL2}declare`,
      `${SHACL2}prefix`,
      `${SHACL2}namespace`
      // Value-sensitive: reported explicitly below rather than by absence, because
      // `sh:reificationRequired false` requires nothing and two thirds of the shapes in
      // docs/ns/iep-shapes-1.2.ttl are exactly that.
    ]);
    SH_IRI = `${SHACL2}IRI`;
    SH_LITERAL = `${SHACL2}Literal`;
    SH_BLANK_NODE = `${SHACL2}BlankNode`;
    SH_BLANK_NODE_OR_IRI = `${SHACL2}BlankNodeOrIRI`;
    SH_BLANK_NODE_OR_LITERAL = `${SHACL2}BlankNodeOrLiteral`;
    SH_IRI_OR_LITERAL = `${SHACL2}IRIOrLiteral`;
    SH_TRIPLE_TERM = `${SHACL2}TripleTerm`;
    NUMERIC_TYPES = new Set([
      "integer",
      "decimal",
      "float",
      "double",
      "long",
      "int",
      "short",
      "byte",
      "nonNegativeInteger",
      "positiveInteger",
      "nonPositiveInteger",
      "negativeInteger",
      "unsignedLong",
      "unsignedInt",
      "unsignedShort",
      "unsignedByte"
    ].map((t) => `${XSD4}${t}`));
    TEMPORAL_TYPES = new Set(
      ["dateTime", "dateTimeStamp", "date"].map((t) => `${XSD4}${t}`)
    );
    SH_RULE = `${SHACL2}rule`;
    SH_TRIPLE_RULE = `${SHACL2}TripleRule`;
    SH_SPARQL_RULE = `${SHACL2}SPARQLRule`;
    SH_SUBJECT = `${SHACL2}subject`;
    SH_PREDICATE = `${SHACL2}predicate`;
    SH_OBJECT = `${SHACL2}object`;
    SH_THIS = `${SHACL2}this`;
    SH_CONSTRUCT = `${SHACL2}construct`;
  }
});

// ../interego-native88/packages/core/src/validation/shacl-rules.ts
var SHACL3, RDF3, RDF_TYPE3, RDF_REIFIES2, SH_RULE2, SH_CONSTRUCT2, SH_CONDITION, SH_DEACTIVATED2, SH_LAYER, SH_ORDER, SH_RUN_ONCE, SH_SUBJECT2, SH_PREDICATE2, SH_OBJECT2, SH_TEMP_TRIPLE, SH_EXPECTED_PREDICATE, SH_SPARQL_RULE2, SH_TRIPLE_RULE2, SH_RULE_CLASS, SH_RULE_SET, SH_HAS_RULE, SH_INCLUDES_RULE_SET, SH_PATH2, SH_PROPERTY2, SH_VALUES2, SH_DEFAULT_VALUE, SH_SHAPE_CLASS2, SH_NODE_SHAPE2, RDFS2, RDFS_CLASS, RDFS_SUBCLASS_OF;
var init_shacl_rules = __esm({
  "../interego-native88/packages/core/src/validation/shacl-rules.ts"() {
    "use strict";
    init_turtle_parser();
    init_sparql_query();
    init_shacl_engine();
    SHACL3 = "http://www.w3.org/ns/shacl#";
    RDF3 = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
    RDF_TYPE3 = `${RDF3}type`;
    RDF_REIFIES2 = `${RDF3}reifies`;
    SH_RULE2 = `${SHACL3}rule`;
    SH_CONSTRUCT2 = `${SHACL3}construct`;
    SH_CONDITION = `${SHACL3}condition`;
    SH_DEACTIVATED2 = `${SHACL3}deactivated`;
    SH_LAYER = `${SHACL3}layer`;
    SH_ORDER = `${SHACL3}order`;
    SH_RUN_ONCE = `${SHACL3}runOnce`;
    SH_SUBJECT2 = `${SHACL3}subject`;
    SH_PREDICATE2 = `${SHACL3}predicate`;
    SH_OBJECT2 = `${SHACL3}object`;
    SH_TEMP_TRIPLE = `${SHACL3}tempTriple`;
    SH_EXPECTED_PREDICATE = `${SHACL3}expectedPredicate`;
    SH_SPARQL_RULE2 = `${SHACL3}SPARQLRule`;
    SH_TRIPLE_RULE2 = `${SHACL3}TripleRule`;
    SH_RULE_CLASS = `${SHACL3}Rule`;
    SH_RULE_SET = `${SHACL3}RuleSet`;
    SH_HAS_RULE = `${SHACL3}hasRule`;
    SH_INCLUDES_RULE_SET = `${SHACL3}includesRuleSet`;
    SH_PATH2 = `${SHACL3}path`;
    SH_PROPERTY2 = `${SHACL3}property`;
    SH_VALUES2 = `${SHACL3}values`;
    SH_DEFAULT_VALUE = `${SHACL3}defaultValue`;
    SH_SHAPE_CLASS2 = `${SHACL3}ShapeClass`;
    SH_NODE_SHAPE2 = `${SHACL3}NodeShape`;
    RDFS2 = "http://www.w3.org/2000/01/rdf-schema#";
    RDFS_CLASS = `${RDFS2}Class`;
    RDFS_SUBCLASS_OF = `${RDFS2}subClassOf`;
  }
});

// ../interego-native88/packages/core/src/validation/index.ts
var init_validation = __esm({
  "../interego-native88/packages/core/src/validation/index.ts"() {
    "use strict";
    init_validator();
    init_shacl_shapes();
    init_node_expression();
    init_sparql_query();
    init_shacl_engine();
    init_shacl_rules();
  }
});

// ../interego-native88/packages/core/src/sparql/patterns.ts
var init_patterns = __esm({
  "../interego-native88/packages/core/src/sparql/patterns.ts"() {
    "use strict";
    init_namespaces();
  }
});

// ../interego-native88/packages/core/src/sparql/index.ts
var init_sparql = __esm({
  "../interego-native88/packages/core/src/sparql/index.ts"() {
    "use strict";
    init_patterns();
  }
});

// ../interego-native88/packages/core/src/http/fetch.ts
function getDefaultFetch() {
  if (typeof globalThis !== "undefined" && typeof globalThis["fetch"] === "function") {
    return globalThis["fetch"];
  }
  throw new Error("No fetch implementation available. Pass one via options.fetch.");
}
var init_fetch = __esm({
  "../interego-native88/packages/core/src/http/fetch.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/http/retry.ts
function isTransientNetworkError(err) {
  if (err === null || err === void 0) return false;
  const cause = err.cause;
  if (cause && typeof cause === "object") {
    const code = cause.code;
    if (typeof code === "string" && TRANSIENT_CAUSE_CODES.has(code)) return true;
  }
  const directCode = err.code;
  if (typeof directCode === "string" && TRANSIENT_CAUSE_CODES.has(directCode)) return true;
  const message = err.message;
  if (typeof message === "string" && (TRANSIENT_PATTERN.test(message) || HTTP_5XX_INTRODUCED.test(message) || HTTP_5XX_WITH_REASON.test(message))) return true;
  return false;
}
async function withTransientRetry(fn, options = {}) {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseMs = options.baseMs ?? 1e3;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err) || attempt === maxAttempts) {
        throw err;
      }
      if (options.onAttempt) {
        try {
          options.onAttempt(attempt, err);
        } catch {
        }
      }
      const backoff = baseMs * Math.pow(2, attempt - 1);
      await new Promise((resolve3) => setTimeout(resolve3, backoff));
    }
  }
  throw lastError;
}
var TRANSIENT_PATTERN, HTTP_5XX_INTRODUCED, HTTP_5XX_WITH_REASON, TRANSIENT_CAUSE_CODES;
var init_retry = __esm({
  "../interego-native88/packages/core/src/http/retry.ts"() {
    "use strict";
    TRANSIENT_PATTERN = /ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT|UND_ERR_SOCKET|fetch failed/;
    HTTP_5XX_INTRODUCED = /(?:\bHTTP\b\s*|\bstatus\b\W{0,2}|\breturned\s+|:\s*)5\d\d(?![0-9A-Za-z])/i;
    HTTP_5XX_WITH_REASON = /(?<![0-9A-Za-z])5\d\d\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*/;
    TRANSIENT_CAUSE_CODES = /* @__PURE__ */ new Set([
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN"
    ]);
  }
});

// ../interego-native88/packages/core/src/http/index.ts
var init_http = __esm({
  "../interego-native88/packages/core/src/http/index.ts"() {
    "use strict";
    init_fetch();
    init_retry();
  }
});

// ../interego-native88/packages/core/src/affordance/compute.ts
var init_compute = __esm({
  "../interego-native88/packages/core/src/affordance/compute.ts"() {
    "use strict";
    init_types();
  }
});

// ../interego-native88/packages/core/src/affordance/engine.ts
var init_engine = __esm({
  "../interego-native88/packages/core/src/affordance/engine.ts"() {
    "use strict";
    init_types();
    init_compute();
  }
});

// ../interego-native88/packages/core/src/http/response-body.ts
var init_response_body = __esm({
  "../interego-native88/packages/core/src/http/response-body.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/kernel/action-identity.ts
var IEP_ACTION_AUTHORITY, URL_AUTHORITY_PREFIX;
var init_action_identity = __esm({
  "../interego-native88/packages/core/src/kernel/action-identity.ts"() {
    "use strict";
    IEP_ACTION_AUTHORITY = (() => {
      const env = typeof process === "undefined" ? void 0 : process.env?.IEP_ACTION_AUTHORITY;
      return (env ?? "https://relay.interego.xwisee.com/ns/iep/action").replace(/\/+$/, "");
    })();
    URL_AUTHORITY_PREFIX = `${IEP_ACTION_AUTHORITY}/`;
  }
});

// ../interego-native88/packages/core/src/kernel/hypermedia.ts
var KERNEL_JSONLD_CONTEXT, KERNEL_RESULT_SHAPES, KERNEL_RESULT_STATUS;
var init_hypermedia = __esm({
  "../interego-native88/packages/core/src/kernel/hypermedia.ts"() {
    "use strict";
    init_namespaces();
    KERNEL_JSONLD_CONTEXT = Object.freeze({
      iep: CG,
      // ns/harness# — the published harness namespace (docs/ns/harness.ttl). The
      // former value here, ns/cgh#, was never published and 404s; readers keep
      // accepting it via CGH_LEGACY.
      ieh: IEH,
      hydra: HYDRA,
      sh: SHACL,
      prov: "http://www.w3.org/ns/prov#",
      dcat: "http://www.w3.org/ns/dcat#",
      dct: "http://purl.org/dc/terms/",
      xsd: "http://www.w3.org/2001/XMLSchema#",
      rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      rdfs: "http://www.w3.org/2000/01/rdf-schema#",
      // Term aliases: lift the wire-level field names that appear in
      // kernel responses onto canonical predicates so a JSON-LD reader
      // resolves them without per-tool config.
      affordances: { "@id": `${CG}affordance`, "@container": "@set" },
      conformsToShape: { "@id": `${SHACL}shapesGraph`, "@type": "@id" },
      operandIris: { "@id": `${CG}operand`, "@container": "@set", "@type": "@id" },
      action: { "@id": `${CG}action`, "@type": "@id" },
      target: { "@id": `${HYDRA}target`, "@type": "@id" },
      method: { "@id": `${HYDRA}method` },
      mediaType: { "@id": `${HYDRA}returnsContentType` },
      expects: { "@id": `${HYDRA}expects`, "@type": "@id" },
      returns: { "@id": `${HYDRA}returns`, "@type": "@id" },
      apex: { "@id": `${CG}apex`, "@type": "@id" },
      left: { "@id": `${CG}left`, "@type": "@id" },
      right: { "@id": `${CG}right`, "@type": "@id" },
      overlap: { "@id": `${CG}overlap`, "@type": "@id" }
    });
    KERNEL_RESULT_SHAPES = Object.freeze({
      holon: `${CG}HolonShape`,
      descriptor: `${CG}ContextDescriptorShape`,
      composed: `${CG}ComposedDescriptorShape`,
      manifest: `${CG}ManifestShape`,
      affordance: `${CG}AffordanceShape`,
      promote: `${CG}PromoteResultShape`,
      decompose: `${CG}DecomposeResultShape`,
      act: `${CG}ActResultShape`,
      dereference: `${CG}DereferenceResultShape`,
      reduce: `${CG}ReduceResultShape`,
      result: `${CG}KernelResultShape`,
      /**
       * ★ THE ONE KIND THAT IS NOT A SUCCESS. Ten kinds above describe ways to succeed and
       * there was no way to DECLINE, so a handler that refused returned an ordinary result whose
       * only signal was an `error` string. The REST dispatch, which sets no status of its own,
       * then sent it as HTTP 200: an unauthenticated call to a published affordance reported
       * SUCCESS to every caller that reads a status code. See `iep:Refusal` in docs/ns/iep.ttl.
       */
      refusal: `${CG}RefusalShape`
    });
    KERNEL_RESULT_STATUS = Object.freeze({
      refusal: 401
    });
  }
});

// ../interego-native88/packages/core/src/affordance/follow.ts
var AFFORDANCE_TYPE_IRIS, CG_ACTION, HYDRA_TARGET, HYDRA_METHOD, DCAT_MEDIA_TYPE;
var init_follow = __esm({
  "../interego-native88/packages/core/src/affordance/follow.ts"() {
    "use strict";
    init_fetch();
    init_retry();
    init_response_body();
    init_turtle_parser();
    init_namespaces();
    init_action_identity();
    init_hypermedia();
    AFFORDANCE_TYPE_IRIS = [
      `${CG}Affordance`,
      // The harness namespace mirror — see applications/_shared/affordance-mcp/index.ts
      `${IEH}Affordance`,
      // Deprecated read-alias: data persisted while the kernel emitted the
      // never-published ns/cgh# IRI still carries this type in its (signed) bytes.
      `${CGH_LEGACY}Affordance`,
      `${HYDRA}Operation`
    ];
    CG_ACTION = `${CG}action`;
    HYDRA_TARGET = `${HYDRA}target`;
    HYDRA_METHOD = `${HYDRA}method`;
    DCAT_MEDIA_TYPE = `${DCAT}mediaType`;
  }
});

// ../interego-native88/packages/core/src/affordance/index.ts
var init_affordance = __esm({
  "../interego-native88/packages/core/src/affordance/index.ts"() {
    "use strict";
    init_compute();
    init_engine();
    init_follow();
  }
});

// ../interego-native88/packages/core/src/crypto/types.ts
var CHAIN_CONFIGS;
var init_types2 = __esm({
  "../interego-native88/packages/core/src/crypto/types.ts"() {
    "use strict";
    CHAIN_CONFIGS = {
      local: {
        mode: "local",
        chainId: 0,
        gasModel: "human-pays"
      },
      "base-sepolia": {
        mode: "base-sepolia",
        chainId: 84532,
        rpcUrl: "https://sepolia.base.org",
        blockExplorer: "https://sepolia.basescan.org",
        faucetUrl: "https://faucet.quicknode.com/base/sepolia",
        gasModel: "sponsored"
      },
      base: {
        mode: "base",
        chainId: 8453,
        rpcUrl: "https://mainnet.base.org",
        blockExplorer: "https://basescan.org",
        gasModel: "human-pays"
      }
    };
  }
});

// ../interego-native88/packages/core/src/crypto/ipfs.ts
var init_ipfs = __esm({
  "../interego-native88/packages/core/src/crypto/ipfs.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/crypto/wallet.ts
var activeChainConfig;
var init_wallet = __esm({
  "../interego-native88/packages/core/src/crypto/wallet.ts"() {
    "use strict";
    init_types2();
    init_ipfs();
    activeChainConfig = CHAIN_CONFIGS.local;
  }
});

// ../../d258232b77e2/interego-durability/node_modules/@noble/curves/utils.js
function abool(value2, title = "") {
  if (typeof value2 !== "boolean") {
    const prefix = title && `"${title}" `;
    throw new TypeError(prefix + "expected boolean, got type=" + typeof value2);
  }
  return value2;
}
function abignumber(n) {
  if (typeof n === "bigint") {
    if (!isPosBig(n))
      throw new RangeError("positive bigint expected, got " + n);
  } else
    anumber2(n);
  return n;
}
function asafenumber(value2, title = "") {
  if (typeof value2 !== "number") {
    const prefix = title && `"${title}" `;
    throw new TypeError(prefix + "expected number, got type=" + typeof value2);
  }
  if (!Number.isSafeInteger(value2)) {
    const prefix = title && `"${title}" `;
    throw new RangeError(prefix + "expected safe integer, got " + value2);
  }
}
function hexToNumber(hex) {
  if (typeof hex !== "string")
    throw new TypeError("hex string expected, got " + typeof hex);
  return hex === "" ? _0n : BigInt("0x" + hex);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  return hexToNumber(bytesToHex(copyBytes(abytes(bytes)).reverse()));
}
function numberToBytesBE(n, len) {
  anumber(len);
  if (len === 0)
    throw new RangeError("zero length");
  n = abignumber(n);
  const hex = n.toString(16);
  if (hex.length > len * 2)
    throw new RangeError("number too large");
  return hexToBytes(hex.padStart(len * 2, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function equalBytes(a, b) {
  a = abytes2(a);
  b = abytes2(b);
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
function copyBytes(bytes) {
  return Uint8Array.from(abytes2(bytes));
}
function asciiToBytes(ascii) {
  if (typeof ascii !== "string")
    throw new TypeError("ascii string expected, got " + typeof ascii);
  return Uint8Array.from(ascii, (c, i) => {
    const charCode = c.charCodeAt(0);
    if (c.length !== 1 || charCode > 127) {
      throw new RangeError(`string contains non-ASCII character "${ascii[i]}" with code ${charCode} at position ${i}`);
    }
    return charCode;
  });
}
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new RangeError("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  if (n < _0n)
    throw new Error("expected non-negative bigint, got " + n);
  let len;
  for (len = 0; n > _0n; n >>= _1n, len += 1)
    ;
  return len;
}
function validateObject(object2, fields2 = {}, optFields = {}) {
  if (Object.prototype.toString.call(object2) !== "[object Object]")
    throw new TypeError("expected valid options object");
  function checkField(fieldName, expectedType, isOpt) {
    if (!isOpt && expectedType !== "function" && !Object.hasOwn(object2, fieldName))
      throw new TypeError(`param "${fieldName}" is invalid: expected own property`);
    const val = object2[fieldName];
    if (isOpt && val === void 0)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new TypeError(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
  }
  const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields2, false);
  iter(optFields, true);
}
var abytes2, anumber2, bytesToHex2, concatBytes2, hexToBytes2, isBytes2, _0n, _1n, isPosBig, bitMask, notImplemented;
var init_utils2 = __esm({
  "../../d258232b77e2/interego-durability/node_modules/@noble/curves/utils.js"() {
    init_utils();
    abytes2 = (value2, length, title) => abytes(value2, length, title);
    anumber2 = anumber;
    bytesToHex2 = bytesToHex;
    concatBytes2 = (...arrays) => concatBytes(...arrays);
    hexToBytes2 = (hex) => hexToBytes(hex);
    isBytes2 = isBytes;
    _0n = /* @__PURE__ */ BigInt(0);
    _1n = /* @__PURE__ */ BigInt(1);
    isPosBig = (n) => typeof n === "bigint" && _0n <= n;
    bitMask = (n) => (_1n << BigInt(n)) - _1n;
    notImplemented = () => {
      throw new Error("not implemented");
    };
  }
});

// ../../d258232b77e2/interego-durability/node_modules/@noble/curves/abstract/modular.js
function mod(a, b) {
  if (b <= _0n2)
    throw new Error("mod: expected positive modulus, got " + b);
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow2(x, power, modulo) {
  if (power < _0n2)
    throw new Error("pow2: expected non-negative exponent, got " + power);
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n2)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b - a * q;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp2, root, n) {
  const F = Fp2;
  if (!F.eql(F.sqr(root), n))
    throw new Error("Cannot find square root");
}
function sqrt3mod4(Fp2, n) {
  const F = Fp2;
  const p1div4 = (F.ORDER + _1n2) / _4n;
  const root = F.pow(n, p1div4);
  assertIsSquare(F, root, n);
  return root;
}
function sqrt5mod8(Fp2, n) {
  const F = Fp2;
  const p5div8 = (F.ORDER - _5n) / _8n;
  const n2 = F.mul(n, _2n);
  const v = F.pow(n2, p5div8);
  const nv = F.mul(n, v);
  const i = F.mul(F.mul(nv, _2n), v);
  const root = F.mul(nv, F.sub(i, F.ONE));
  assertIsSquare(F, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return ((Fp2, n) => {
    const F = Fp2;
    let tv1 = F.pow(n, c4);
    let tv2 = F.mul(tv1, c1);
    const tv3 = F.mul(tv1, c2);
    const tv4 = F.mul(tv1, c3);
    const e1 = F.eql(F.sqr(tv2), n);
    const e2 = F.eql(F.sqr(tv3), n);
    tv1 = F.cmov(tv1, tv2, e1);
    tv2 = F.cmov(tv4, tv3, e2);
    const e3 = F.eql(F.sqr(tv2), n);
    const root = F.cmov(tv1, tv2, e3);
    assertIsSquare(F, root, n);
    return root;
  });
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  let Q = P - _1n2;
  let S2 = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S2++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S2 === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp2, n) {
    const F = Fp2;
    if (F.is0(n))
      return n;
    if (FpLegendre(F, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S2;
    let c = F.mul(F.ONE, cc);
    let t = F.pow(n, Q);
    let R = F.pow(n, Q1div2);
    while (!F.eql(t, F.ONE)) {
      if (F.is0(t))
        return F.ZERO;
      let i = 1;
      let t_tmp = F.sqr(t);
      while (!F.eql(t_tmp, F.ONE)) {
        i++;
        t_tmp = F.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = F.pow(c, exponent);
      M = i;
      c = F.sqr(b);
      t = F.mul(t, c);
      R = F.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    BYTES: "number",
    BITS: "number"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  validateObject(field, opts);
  asafenumber(field.BYTES, "BYTES");
  asafenumber(field.BITS, "BITS");
  if (field.BYTES < 1 || field.BITS < 1)
    throw new Error("invalid field: expected BYTES/BITS > 0");
  if (field.ORDER <= _1n2)
    throw new Error("invalid field: expected ORDER > 1, got " + field.ORDER);
  return field;
}
function FpPow(Fp2, num, power) {
  const F = Fp2;
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return F.ONE;
  if (power === _1n2)
    return num;
  let p = F.ONE;
  let d = num;
  while (power > _0n2) {
    if (power & _1n2)
      p = F.mul(p, d);
    d = F.sqr(d);
    power >>= _1n2;
  }
  return p;
}
function FpInvertBatch(Fp2, nums, passZero = false) {
  const F = Fp2;
  const inverted = new Array(nums.length).fill(passZero ? F.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = acc;
    return F.mul(acc, num);
  }, F.ONE);
  const invertedAcc = F.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (F.is0(num))
      return acc;
    inverted[i] = F.mul(acc, inverted[i]);
    return F.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp2, n) {
  const F = Fp2;
  const p1mod2 = (F.ORDER - _1n2) / _2n;
  const powered = F.pow(n, p1mod2);
  const yes = F.eql(powered, F.ONE);
  const zero = F.eql(powered, F.ZERO);
  const no = F.eql(powered, F.neg(F.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber2(nBitLength);
  if (n <= _0n2)
    throw new Error("invalid n length: expected positive n, got " + n);
  if (nBitLength !== void 0 && nBitLength < 1)
    throw new Error("invalid n length: expected positive bit length, got " + nBitLength);
  const bits = bitLen(n);
  if (nBitLength !== void 0 && nBitLength < bits)
    throw new Error(`invalid n length: expected bit length (${bits}) >= n.length (${nBitLength})`);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : bits;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
function Field(ORDER, opts = {}) {
  return new _Field(ORDER, opts);
}
var _0n2, _1n2, _2n, _3n, _4n, _5n, _7n, _8n, _9n, _16n, isNegativeLE, FIELD_FIELDS, FIELD_SQRT, _Field;
var init_modular = __esm({
  "../../d258232b77e2/interego-durability/node_modules/@noble/curves/abstract/modular.js"() {
    init_utils2();
    _0n2 = /* @__PURE__ */ BigInt(0);
    _1n2 = /* @__PURE__ */ BigInt(1);
    _2n = /* @__PURE__ */ BigInt(2);
    _3n = /* @__PURE__ */ BigInt(3);
    _4n = /* @__PURE__ */ BigInt(4);
    _5n = /* @__PURE__ */ BigInt(5);
    _7n = /* @__PURE__ */ BigInt(7);
    _8n = /* @__PURE__ */ BigInt(8);
    _9n = /* @__PURE__ */ BigInt(9);
    _16n = /* @__PURE__ */ BigInt(16);
    isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n2) === _1n2;
    FIELD_FIELDS = [
      "create",
      "isValid",
      "is0",
      "neg",
      "inv",
      "sqrt",
      "sqr",
      "eql",
      "add",
      "sub",
      "mul",
      "pow",
      "div",
      "addN",
      "subN",
      "mulN",
      "sqrN"
    ];
    FIELD_SQRT = /* @__PURE__ */ new WeakMap();
    _Field = class {
      ORDER;
      BITS;
      BYTES;
      isLE;
      ZERO = _0n2;
      ONE = _1n2;
      _lengths;
      _mod;
      constructor(ORDER, opts = {}) {
        if (ORDER <= _1n2)
          throw new Error("invalid field: expected ORDER > 1, got " + ORDER);
        let _nbitLength = void 0;
        this.isLE = false;
        if (opts != null && typeof opts === "object") {
          if (typeof opts.BITS === "number")
            _nbitLength = opts.BITS;
          if (typeof opts.sqrt === "function")
            Object.defineProperty(this, "sqrt", { value: opts.sqrt, enumerable: true });
          if (typeof opts.isLE === "boolean")
            this.isLE = opts.isLE;
          if (opts.allowedLengths)
            this._lengths = Object.freeze(opts.allowedLengths.slice());
          if (typeof opts.modFromBytes === "boolean")
            this._mod = opts.modFromBytes;
        }
        const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
        if (nByteLength > 2048)
          throw new Error("invalid field: expected ORDER of <= 2048 bytes");
        this.ORDER = ORDER;
        this.BITS = nBitLength;
        this.BYTES = nByteLength;
        Object.freeze(this);
      }
      create(num) {
        return mod(num, this.ORDER);
      }
      isValid(num) {
        if (typeof num !== "bigint")
          throw new TypeError("invalid field element: expected bigint, got " + typeof num);
        return _0n2 <= num && num < this.ORDER;
      }
      is0(num) {
        return num === _0n2;
      }
      // is valid and invertible
      isValidNot0(num) {
        return !this.is0(num) && this.isValid(num);
      }
      isOdd(num) {
        return (num & _1n2) === _1n2;
      }
      neg(num) {
        return mod(-num, this.ORDER);
      }
      eql(lhs, rhs) {
        return lhs === rhs;
      }
      sqr(num) {
        return mod(num * num, this.ORDER);
      }
      add(lhs, rhs) {
        return mod(lhs + rhs, this.ORDER);
      }
      sub(lhs, rhs) {
        return mod(lhs - rhs, this.ORDER);
      }
      mul(lhs, rhs) {
        return mod(lhs * rhs, this.ORDER);
      }
      pow(num, power) {
        return FpPow(this, num, power);
      }
      div(lhs, rhs) {
        return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
      }
      // Same as above, but doesn't normalize
      sqrN(num) {
        return num * num;
      }
      addN(lhs, rhs) {
        return lhs + rhs;
      }
      subN(lhs, rhs) {
        return lhs - rhs;
      }
      mulN(lhs, rhs) {
        return lhs * rhs;
      }
      inv(num) {
        return invert(num, this.ORDER);
      }
      sqrt(num) {
        let sqrt = FIELD_SQRT.get(this);
        if (!sqrt)
          FIELD_SQRT.set(this, sqrt = FpSqrt(this.ORDER));
        return sqrt(this, num);
      }
      toBytes(num) {
        return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
      }
      fromBytes(bytes, skipValidation = false) {
        abytes2(bytes);
        const { _lengths: allowedLengths, BYTES: BYTES2, isLE, ORDER, _mod: modFromBytes } = this;
        if (allowedLengths) {
          if (bytes.length < 1 || !allowedLengths.includes(bytes.length) || bytes.length > BYTES2) {
            throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
          }
          const padded = new Uint8Array(BYTES2);
          padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
          bytes = padded;
        }
        if (bytes.length !== BYTES2)
          throw new Error("Field.fromBytes: expected " + BYTES2 + " bytes, got " + bytes.length);
        let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
        if (modFromBytes)
          scalar = mod(scalar, ORDER);
        if (!skipValidation) {
          if (!this.isValid(scalar))
            throw new Error("invalid field element: outside of range 0..ORDER");
        }
        return scalar;
      }
      // TODO: we don't need it here, move out to separate fn
      invertBatch(lst) {
        return FpInvertBatch(this, lst);
      }
      // We can't move this out because Fp6, Fp12 implement it
      // and it's unclear what to return in there.
      cmov(a, b, condition) {
        abool(condition, "condition");
        return condition ? b : a;
      }
    };
    Object.freeze(_Field.prototype);
  }
});

// ../../d258232b77e2/interego-durability/node_modules/@noble/curves/abstract/curve.js
function negateCt(condition, item) {
  const neg = item.negate();
  return condition ? neg : item;
}
function normalizeZ(c, points) {
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
    throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, scalarBits) {
  validateW(W, scalarBits);
  const windows = Math.ceil(scalarBits / W) + 1;
  const windowSize = 2 ** (W - 1);
  const maxNumber = 2 ** W;
  const mask = bitMask(W);
  const shiftBy = BigInt(W);
  return { windows, windowSize, mask, maxNumber, shiftBy };
}
function calcOffsets(n, window, wOpts) {
  const { windowSize, mask, maxNumber, shiftBy } = wOpts;
  let wbits = Number(n & mask);
  let nextN = n >> shiftBy;
  if (wbits > windowSize) {
    wbits -= maxNumber;
    nextN += _1n3;
  }
  const offsetStart = window * windowSize;
  const offset = offsetStart + Math.abs(wbits) - 1;
  const isZero = wbits === 0;
  const isNeg = wbits < 0;
  const isNegF = window % 2 !== 0;
  const offsetF = offsetStart;
  return { nextN, offset, isZero, isNeg, isNegF, offsetF };
}
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
function assert0(n) {
  if (n !== _0n3)
    throw new Error("invalid wNAF");
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE });
  }
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (FpFnLE === void 0)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(typeof val === "bigint" && val > _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp2 = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn2 = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp2.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp: Fp2, Fn: Fn2 };
}
var _0n3, _1n3, pointPrecomputes, pointWindowSizes, wNAF;
var init_curve = __esm({
  "../../d258232b77e2/interego-durability/node_modules/@noble/curves/abstract/curve.js"() {
    init_utils2();
    init_modular();
    _0n3 = /* @__PURE__ */ BigInt(0);
    _1n3 = /* @__PURE__ */ BigInt(1);
    pointPrecomputes = /* @__PURE__ */ new WeakMap();
    pointWindowSizes = /* @__PURE__ */ new WeakMap();
    wNAF = class {
      BASE;
      ZERO;
      Fn;
      bits;
      // Parametrized with a given Point class (not individual point)
      constructor(Point, bits) {
        this.BASE = Point.BASE;
        this.ZERO = Point.ZERO;
        this.Fn = Point.Fn;
        this.bits = bits;
      }
      // non-const time multiplication ladder
      _unsafeLadder(elm, n, p = this.ZERO) {
        let d = elm;
        while (n > _0n3) {
          if (n & _1n3)
            p = p.add(d);
          d = d.double();
          n >>= _1n3;
        }
        return p;
      }
      /**
       * Creates a wNAF precomputation window. Used for caching.
       * Default window size is set by `utils.precompute()` and is equal to 8.
       * Number of precomputed points depends on the curve size:
       * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
       * - 𝑊 is the window size
       * - 𝑛 is the bitlength of the curve order.
       * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
       * @param point - Point instance
       * @param W - window size
       * @returns precomputed point tables flattened to a single array
       */
      precomputeWindow(point, W) {
        const { windows, windowSize } = calcWOpts(W, this.bits);
        const points = [];
        let p = point;
        let base = p;
        for (let window = 0; window < windows; window++) {
          base = p;
          points.push(base);
          for (let i = 1; i < windowSize; i++) {
            base = base.add(p);
            points.push(base);
          }
          p = base.double();
        }
        return points;
      }
      /**
       * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
       * More compact implementation:
       * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
       * @returns real and fake (for const-time) points
       */
      wNAF(W, precomputes, n) {
        if (!this.Fn.isValid(n))
          throw new Error("invalid scalar");
        let p = this.ZERO;
        let f = this.BASE;
        const wo = calcWOpts(W, this.bits);
        for (let window = 0; window < wo.windows; window++) {
          const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
          n = nextN;
          if (isZero) {
            f = f.add(negateCt(isNegF, precomputes[offsetF]));
          } else {
            p = p.add(negateCt(isNeg, precomputes[offset]));
          }
        }
        assert0(n);
        return { p, f };
      }
      /**
       * Implements unsafe EC multiplication using precomputed tables
       * and w-ary non-adjacent form.
       * @param acc - accumulator point to add result of multiplication
       * @returns point
       */
      wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
        const wo = calcWOpts(W, this.bits);
        for (let window = 0; window < wo.windows; window++) {
          if (n === _0n3)
            break;
          const { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);
          n = nextN;
          if (isZero) {
            continue;
          } else {
            const item = precomputes[offset];
            acc = acc.add(isNeg ? item.negate() : item);
          }
        }
        assert0(n);
        return acc;
      }
      getPrecomputes(W, point, transform) {
        let comp = pointPrecomputes.get(point);
        if (!comp) {
          comp = this.precomputeWindow(point, W);
          if (W !== 1) {
            if (typeof transform === "function")
              comp = transform(comp);
            pointPrecomputes.set(point, comp);
          }
        }
        return comp;
      }
      cached(point, scalar, transform) {
        const W = getW(point);
        return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
      }
      unsafe(point, scalar, transform, prev) {
        const W = getW(point);
        if (W === 1)
          return this._unsafeLadder(point, scalar, prev);
        return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
      }
      // We calculate precomputes for elliptic curve point multiplication
      // using windowed method. This specifies window size and
      // stores precomputed values. Usually only base point would be precomputed.
      createCache(P, W) {
        validateW(W, this.bits);
        pointWindowSizes.set(P, W);
        pointPrecomputes.delete(P);
      }
      hasCache(elm) {
        return getW(elm) !== 1;
      }
    };
  }
});

// ../../d258232b77e2/interego-durability/node_modules/@noble/curves/abstract/hash-to-curve.js
function i2osp(value2, length) {
  asafenumber(value2);
  asafenumber(length);
  if (length < 0 || length > 4)
    throw new Error("invalid I2OSP length: " + length);
  if (value2 < 0 || value2 > 2 ** (8 * length) - 1)
    throw new Error("invalid I2OSP input: " + value2);
  const res = Array.from({ length }).fill(0);
  for (let i = length - 1; i >= 0; i--) {
    res[i] = value2 & 255;
    value2 >>>= 8;
  }
  return new Uint8Array(res);
}
function strxor(a, b) {
  const arr = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    arr[i] = a[i] ^ b[i];
  }
  return arr;
}
function normDST(DST) {
  if (!isBytes2(DST) && typeof DST !== "string")
    throw new Error("DST must be Uint8Array or ascii string");
  const dst = typeof DST === "string" ? asciiToBytes(DST) : DST;
  if (dst.length === 0)
    throw new Error("DST must be non-empty");
  return dst;
}
function expand_message_xmd(msg, DST, lenInBytes, H3) {
  abytes2(msg);
  asafenumber(lenInBytes);
  DST = normDST(DST);
  if (DST.length > 255)
    DST = H3(concatBytes2(asciiToBytes("H2C-OVERSIZE-DST-"), DST));
  const { outputLen: b_in_bytes, blockLen: r_in_bytes } = H3;
  const ell = Math.ceil(lenInBytes / b_in_bytes);
  if (lenInBytes > 65535 || ell > 255)
    throw new Error("expand_message_xmd: invalid lenInBytes");
  const DST_prime = concatBytes2(DST, i2osp(DST.length, 1));
  const Z_pad = new Uint8Array(r_in_bytes);
  const l_i_b_str = i2osp(lenInBytes, 2);
  const b = new Array(ell);
  const b_0 = H3(concatBytes2(Z_pad, msg, l_i_b_str, i2osp(0, 1), DST_prime));
  b[0] = H3(concatBytes2(b_0, i2osp(1, 1), DST_prime));
  for (let i = 1; i < ell; i++) {
    const args = [strxor(b_0, b[i - 1]), i2osp(i + 1, 1), DST_prime];
    b[i] = H3(concatBytes2(...args));
  }
  const pseudo_random_bytes = concatBytes2(...b);
  return pseudo_random_bytes.slice(0, lenInBytes);
}
var _DST_scalar;
var init_hash_to_curve = __esm({
  "../../d258232b77e2/interego-durability/node_modules/@noble/curves/abstract/hash-to-curve.js"() {
    init_utils2();
    _DST_scalar = "HashToScalar-";
  }
});

// ../interego-native88/packages/core/src/crypto/schnorr.ts
var init_schnorr = __esm({
  "../interego-native88/packages/core/src/crypto/schnorr.ts"() {
    "use strict";
  }
});

// ../../d258232b77e2/interego-durability/node_modules/tweetnacl/nacl-fast.js
var require_nacl_fast = __commonJS({
  "../../d258232b77e2/interego-durability/node_modules/tweetnacl/nacl-fast.js"(exports, module) {
    (function(nacl3) {
      "use strict";
      var gf = function(init) {
        var i, r = new Float64Array(16);
        if (init) for (i = 0; i < init.length; i++) r[i] = init[i];
        return r;
      };
      var randombytes = function() {
        throw new Error("no PRNG");
      };
      var _0 = new Uint8Array(16);
      var _9 = new Uint8Array(32);
      _9[0] = 9;
      var gf0 = gf(), gf1 = gf([1]), _121665 = gf([56129, 1]), D2 = gf([30883, 4953, 19914, 30187, 55467, 16705, 2637, 112, 59544, 30585, 16505, 36039, 65139, 11119, 27886, 20995]), D22 = gf([61785, 9906, 39828, 60374, 45398, 33411, 5274, 224, 53552, 61171, 33010, 6542, 64743, 22239, 55772, 9222]), X = gf([54554, 36645, 11616, 51542, 42930, 38181, 51040, 26924, 56412, 64982, 57905, 49316, 21502, 52590, 14035, 8553]), Y = gf([26200, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214, 26214]), I = gf([41136, 18958, 6951, 50414, 58488, 44335, 6150, 12099, 55207, 15867, 153, 11085, 57099, 20417, 9344, 11139]);
      function ts64(x, i, h, l) {
        x[i] = h >> 24 & 255;
        x[i + 1] = h >> 16 & 255;
        x[i + 2] = h >> 8 & 255;
        x[i + 3] = h & 255;
        x[i + 4] = l >> 24 & 255;
        x[i + 5] = l >> 16 & 255;
        x[i + 6] = l >> 8 & 255;
        x[i + 7] = l & 255;
      }
      function vn(x, xi, y, yi, n) {
        var i, d = 0;
        for (i = 0; i < n; i++) d |= x[xi + i] ^ y[yi + i];
        return (1 & d - 1 >>> 8) - 1;
      }
      function crypto_verify_16(x, xi, y, yi) {
        return vn(x, xi, y, yi, 16);
      }
      function crypto_verify_32(x, xi, y, yi) {
        return vn(x, xi, y, yi, 32);
      }
      function core_salsa20(o, p, k, c) {
        var j0 = c[0] & 255 | (c[1] & 255) << 8 | (c[2] & 255) << 16 | (c[3] & 255) << 24, j1 = k[0] & 255 | (k[1] & 255) << 8 | (k[2] & 255) << 16 | (k[3] & 255) << 24, j2 = k[4] & 255 | (k[5] & 255) << 8 | (k[6] & 255) << 16 | (k[7] & 255) << 24, j3 = k[8] & 255 | (k[9] & 255) << 8 | (k[10] & 255) << 16 | (k[11] & 255) << 24, j4 = k[12] & 255 | (k[13] & 255) << 8 | (k[14] & 255) << 16 | (k[15] & 255) << 24, j5 = c[4] & 255 | (c[5] & 255) << 8 | (c[6] & 255) << 16 | (c[7] & 255) << 24, j6 = p[0] & 255 | (p[1] & 255) << 8 | (p[2] & 255) << 16 | (p[3] & 255) << 24, j7 = p[4] & 255 | (p[5] & 255) << 8 | (p[6] & 255) << 16 | (p[7] & 255) << 24, j8 = p[8] & 255 | (p[9] & 255) << 8 | (p[10] & 255) << 16 | (p[11] & 255) << 24, j9 = p[12] & 255 | (p[13] & 255) << 8 | (p[14] & 255) << 16 | (p[15] & 255) << 24, j10 = c[8] & 255 | (c[9] & 255) << 8 | (c[10] & 255) << 16 | (c[11] & 255) << 24, j11 = k[16] & 255 | (k[17] & 255) << 8 | (k[18] & 255) << 16 | (k[19] & 255) << 24, j12 = k[20] & 255 | (k[21] & 255) << 8 | (k[22] & 255) << 16 | (k[23] & 255) << 24, j13 = k[24] & 255 | (k[25] & 255) << 8 | (k[26] & 255) << 16 | (k[27] & 255) << 24, j14 = k[28] & 255 | (k[29] & 255) << 8 | (k[30] & 255) << 16 | (k[31] & 255) << 24, j15 = c[12] & 255 | (c[13] & 255) << 8 | (c[14] & 255) << 16 | (c[15] & 255) << 24;
        var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7, x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15, u;
        for (var i = 0; i < 20; i += 2) {
          u = x0 + x12 | 0;
          x4 ^= u << 7 | u >>> 32 - 7;
          u = x4 + x0 | 0;
          x8 ^= u << 9 | u >>> 32 - 9;
          u = x8 + x4 | 0;
          x12 ^= u << 13 | u >>> 32 - 13;
          u = x12 + x8 | 0;
          x0 ^= u << 18 | u >>> 32 - 18;
          u = x5 + x1 | 0;
          x9 ^= u << 7 | u >>> 32 - 7;
          u = x9 + x5 | 0;
          x13 ^= u << 9 | u >>> 32 - 9;
          u = x13 + x9 | 0;
          x1 ^= u << 13 | u >>> 32 - 13;
          u = x1 + x13 | 0;
          x5 ^= u << 18 | u >>> 32 - 18;
          u = x10 + x6 | 0;
          x14 ^= u << 7 | u >>> 32 - 7;
          u = x14 + x10 | 0;
          x2 ^= u << 9 | u >>> 32 - 9;
          u = x2 + x14 | 0;
          x6 ^= u << 13 | u >>> 32 - 13;
          u = x6 + x2 | 0;
          x10 ^= u << 18 | u >>> 32 - 18;
          u = x15 + x11 | 0;
          x3 ^= u << 7 | u >>> 32 - 7;
          u = x3 + x15 | 0;
          x7 ^= u << 9 | u >>> 32 - 9;
          u = x7 + x3 | 0;
          x11 ^= u << 13 | u >>> 32 - 13;
          u = x11 + x7 | 0;
          x15 ^= u << 18 | u >>> 32 - 18;
          u = x0 + x3 | 0;
          x1 ^= u << 7 | u >>> 32 - 7;
          u = x1 + x0 | 0;
          x2 ^= u << 9 | u >>> 32 - 9;
          u = x2 + x1 | 0;
          x3 ^= u << 13 | u >>> 32 - 13;
          u = x3 + x2 | 0;
          x0 ^= u << 18 | u >>> 32 - 18;
          u = x5 + x4 | 0;
          x6 ^= u << 7 | u >>> 32 - 7;
          u = x6 + x5 | 0;
          x7 ^= u << 9 | u >>> 32 - 9;
          u = x7 + x6 | 0;
          x4 ^= u << 13 | u >>> 32 - 13;
          u = x4 + x7 | 0;
          x5 ^= u << 18 | u >>> 32 - 18;
          u = x10 + x9 | 0;
          x11 ^= u << 7 | u >>> 32 - 7;
          u = x11 + x10 | 0;
          x8 ^= u << 9 | u >>> 32 - 9;
          u = x8 + x11 | 0;
          x9 ^= u << 13 | u >>> 32 - 13;
          u = x9 + x8 | 0;
          x10 ^= u << 18 | u >>> 32 - 18;
          u = x15 + x14 | 0;
          x12 ^= u << 7 | u >>> 32 - 7;
          u = x12 + x15 | 0;
          x13 ^= u << 9 | u >>> 32 - 9;
          u = x13 + x12 | 0;
          x14 ^= u << 13 | u >>> 32 - 13;
          u = x14 + x13 | 0;
          x15 ^= u << 18 | u >>> 32 - 18;
        }
        x0 = x0 + j0 | 0;
        x1 = x1 + j1 | 0;
        x2 = x2 + j2 | 0;
        x3 = x3 + j3 | 0;
        x4 = x4 + j4 | 0;
        x5 = x5 + j5 | 0;
        x6 = x6 + j6 | 0;
        x7 = x7 + j7 | 0;
        x8 = x8 + j8 | 0;
        x9 = x9 + j9 | 0;
        x10 = x10 + j10 | 0;
        x11 = x11 + j11 | 0;
        x12 = x12 + j12 | 0;
        x13 = x13 + j13 | 0;
        x14 = x14 + j14 | 0;
        x15 = x15 + j15 | 0;
        o[0] = x0 >>> 0 & 255;
        o[1] = x0 >>> 8 & 255;
        o[2] = x0 >>> 16 & 255;
        o[3] = x0 >>> 24 & 255;
        o[4] = x1 >>> 0 & 255;
        o[5] = x1 >>> 8 & 255;
        o[6] = x1 >>> 16 & 255;
        o[7] = x1 >>> 24 & 255;
        o[8] = x2 >>> 0 & 255;
        o[9] = x2 >>> 8 & 255;
        o[10] = x2 >>> 16 & 255;
        o[11] = x2 >>> 24 & 255;
        o[12] = x3 >>> 0 & 255;
        o[13] = x3 >>> 8 & 255;
        o[14] = x3 >>> 16 & 255;
        o[15] = x3 >>> 24 & 255;
        o[16] = x4 >>> 0 & 255;
        o[17] = x4 >>> 8 & 255;
        o[18] = x4 >>> 16 & 255;
        o[19] = x4 >>> 24 & 255;
        o[20] = x5 >>> 0 & 255;
        o[21] = x5 >>> 8 & 255;
        o[22] = x5 >>> 16 & 255;
        o[23] = x5 >>> 24 & 255;
        o[24] = x6 >>> 0 & 255;
        o[25] = x6 >>> 8 & 255;
        o[26] = x6 >>> 16 & 255;
        o[27] = x6 >>> 24 & 255;
        o[28] = x7 >>> 0 & 255;
        o[29] = x7 >>> 8 & 255;
        o[30] = x7 >>> 16 & 255;
        o[31] = x7 >>> 24 & 255;
        o[32] = x8 >>> 0 & 255;
        o[33] = x8 >>> 8 & 255;
        o[34] = x8 >>> 16 & 255;
        o[35] = x8 >>> 24 & 255;
        o[36] = x9 >>> 0 & 255;
        o[37] = x9 >>> 8 & 255;
        o[38] = x9 >>> 16 & 255;
        o[39] = x9 >>> 24 & 255;
        o[40] = x10 >>> 0 & 255;
        o[41] = x10 >>> 8 & 255;
        o[42] = x10 >>> 16 & 255;
        o[43] = x10 >>> 24 & 255;
        o[44] = x11 >>> 0 & 255;
        o[45] = x11 >>> 8 & 255;
        o[46] = x11 >>> 16 & 255;
        o[47] = x11 >>> 24 & 255;
        o[48] = x12 >>> 0 & 255;
        o[49] = x12 >>> 8 & 255;
        o[50] = x12 >>> 16 & 255;
        o[51] = x12 >>> 24 & 255;
        o[52] = x13 >>> 0 & 255;
        o[53] = x13 >>> 8 & 255;
        o[54] = x13 >>> 16 & 255;
        o[55] = x13 >>> 24 & 255;
        o[56] = x14 >>> 0 & 255;
        o[57] = x14 >>> 8 & 255;
        o[58] = x14 >>> 16 & 255;
        o[59] = x14 >>> 24 & 255;
        o[60] = x15 >>> 0 & 255;
        o[61] = x15 >>> 8 & 255;
        o[62] = x15 >>> 16 & 255;
        o[63] = x15 >>> 24 & 255;
      }
      function core_hsalsa20(o, p, k, c) {
        var j0 = c[0] & 255 | (c[1] & 255) << 8 | (c[2] & 255) << 16 | (c[3] & 255) << 24, j1 = k[0] & 255 | (k[1] & 255) << 8 | (k[2] & 255) << 16 | (k[3] & 255) << 24, j2 = k[4] & 255 | (k[5] & 255) << 8 | (k[6] & 255) << 16 | (k[7] & 255) << 24, j3 = k[8] & 255 | (k[9] & 255) << 8 | (k[10] & 255) << 16 | (k[11] & 255) << 24, j4 = k[12] & 255 | (k[13] & 255) << 8 | (k[14] & 255) << 16 | (k[15] & 255) << 24, j5 = c[4] & 255 | (c[5] & 255) << 8 | (c[6] & 255) << 16 | (c[7] & 255) << 24, j6 = p[0] & 255 | (p[1] & 255) << 8 | (p[2] & 255) << 16 | (p[3] & 255) << 24, j7 = p[4] & 255 | (p[5] & 255) << 8 | (p[6] & 255) << 16 | (p[7] & 255) << 24, j8 = p[8] & 255 | (p[9] & 255) << 8 | (p[10] & 255) << 16 | (p[11] & 255) << 24, j9 = p[12] & 255 | (p[13] & 255) << 8 | (p[14] & 255) << 16 | (p[15] & 255) << 24, j10 = c[8] & 255 | (c[9] & 255) << 8 | (c[10] & 255) << 16 | (c[11] & 255) << 24, j11 = k[16] & 255 | (k[17] & 255) << 8 | (k[18] & 255) << 16 | (k[19] & 255) << 24, j12 = k[20] & 255 | (k[21] & 255) << 8 | (k[22] & 255) << 16 | (k[23] & 255) << 24, j13 = k[24] & 255 | (k[25] & 255) << 8 | (k[26] & 255) << 16 | (k[27] & 255) << 24, j14 = k[28] & 255 | (k[29] & 255) << 8 | (k[30] & 255) << 16 | (k[31] & 255) << 24, j15 = c[12] & 255 | (c[13] & 255) << 8 | (c[14] & 255) << 16 | (c[15] & 255) << 24;
        var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7, x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14, x15 = j15, u;
        for (var i = 0; i < 20; i += 2) {
          u = x0 + x12 | 0;
          x4 ^= u << 7 | u >>> 32 - 7;
          u = x4 + x0 | 0;
          x8 ^= u << 9 | u >>> 32 - 9;
          u = x8 + x4 | 0;
          x12 ^= u << 13 | u >>> 32 - 13;
          u = x12 + x8 | 0;
          x0 ^= u << 18 | u >>> 32 - 18;
          u = x5 + x1 | 0;
          x9 ^= u << 7 | u >>> 32 - 7;
          u = x9 + x5 | 0;
          x13 ^= u << 9 | u >>> 32 - 9;
          u = x13 + x9 | 0;
          x1 ^= u << 13 | u >>> 32 - 13;
          u = x1 + x13 | 0;
          x5 ^= u << 18 | u >>> 32 - 18;
          u = x10 + x6 | 0;
          x14 ^= u << 7 | u >>> 32 - 7;
          u = x14 + x10 | 0;
          x2 ^= u << 9 | u >>> 32 - 9;
          u = x2 + x14 | 0;
          x6 ^= u << 13 | u >>> 32 - 13;
          u = x6 + x2 | 0;
          x10 ^= u << 18 | u >>> 32 - 18;
          u = x15 + x11 | 0;
          x3 ^= u << 7 | u >>> 32 - 7;
          u = x3 + x15 | 0;
          x7 ^= u << 9 | u >>> 32 - 9;
          u = x7 + x3 | 0;
          x11 ^= u << 13 | u >>> 32 - 13;
          u = x11 + x7 | 0;
          x15 ^= u << 18 | u >>> 32 - 18;
          u = x0 + x3 | 0;
          x1 ^= u << 7 | u >>> 32 - 7;
          u = x1 + x0 | 0;
          x2 ^= u << 9 | u >>> 32 - 9;
          u = x2 + x1 | 0;
          x3 ^= u << 13 | u >>> 32 - 13;
          u = x3 + x2 | 0;
          x0 ^= u << 18 | u >>> 32 - 18;
          u = x5 + x4 | 0;
          x6 ^= u << 7 | u >>> 32 - 7;
          u = x6 + x5 | 0;
          x7 ^= u << 9 | u >>> 32 - 9;
          u = x7 + x6 | 0;
          x4 ^= u << 13 | u >>> 32 - 13;
          u = x4 + x7 | 0;
          x5 ^= u << 18 | u >>> 32 - 18;
          u = x10 + x9 | 0;
          x11 ^= u << 7 | u >>> 32 - 7;
          u = x11 + x10 | 0;
          x8 ^= u << 9 | u >>> 32 - 9;
          u = x8 + x11 | 0;
          x9 ^= u << 13 | u >>> 32 - 13;
          u = x9 + x8 | 0;
          x10 ^= u << 18 | u >>> 32 - 18;
          u = x15 + x14 | 0;
          x12 ^= u << 7 | u >>> 32 - 7;
          u = x12 + x15 | 0;
          x13 ^= u << 9 | u >>> 32 - 9;
          u = x13 + x12 | 0;
          x14 ^= u << 13 | u >>> 32 - 13;
          u = x14 + x13 | 0;
          x15 ^= u << 18 | u >>> 32 - 18;
        }
        o[0] = x0 >>> 0 & 255;
        o[1] = x0 >>> 8 & 255;
        o[2] = x0 >>> 16 & 255;
        o[3] = x0 >>> 24 & 255;
        o[4] = x5 >>> 0 & 255;
        o[5] = x5 >>> 8 & 255;
        o[6] = x5 >>> 16 & 255;
        o[7] = x5 >>> 24 & 255;
        o[8] = x10 >>> 0 & 255;
        o[9] = x10 >>> 8 & 255;
        o[10] = x10 >>> 16 & 255;
        o[11] = x10 >>> 24 & 255;
        o[12] = x15 >>> 0 & 255;
        o[13] = x15 >>> 8 & 255;
        o[14] = x15 >>> 16 & 255;
        o[15] = x15 >>> 24 & 255;
        o[16] = x6 >>> 0 & 255;
        o[17] = x6 >>> 8 & 255;
        o[18] = x6 >>> 16 & 255;
        o[19] = x6 >>> 24 & 255;
        o[20] = x7 >>> 0 & 255;
        o[21] = x7 >>> 8 & 255;
        o[22] = x7 >>> 16 & 255;
        o[23] = x7 >>> 24 & 255;
        o[24] = x8 >>> 0 & 255;
        o[25] = x8 >>> 8 & 255;
        o[26] = x8 >>> 16 & 255;
        o[27] = x8 >>> 24 & 255;
        o[28] = x9 >>> 0 & 255;
        o[29] = x9 >>> 8 & 255;
        o[30] = x9 >>> 16 & 255;
        o[31] = x9 >>> 24 & 255;
      }
      function crypto_core_salsa20(out, inp, k, c) {
        core_salsa20(out, inp, k, c);
      }
      function crypto_core_hsalsa20(out, inp, k, c) {
        core_hsalsa20(out, inp, k, c);
      }
      var sigma = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107]);
      function crypto_stream_salsa20_xor(c, cpos, m, mpos, b, n, k) {
        var z = new Uint8Array(16), x = new Uint8Array(64);
        var u, i;
        for (i = 0; i < 16; i++) z[i] = 0;
        for (i = 0; i < 8; i++) z[i] = n[i];
        while (b >= 64) {
          crypto_core_salsa20(x, z, k, sigma);
          for (i = 0; i < 64; i++) c[cpos + i] = m[mpos + i] ^ x[i];
          u = 1;
          for (i = 8; i < 16; i++) {
            u = u + (z[i] & 255) | 0;
            z[i] = u & 255;
            u >>>= 8;
          }
          b -= 64;
          cpos += 64;
          mpos += 64;
        }
        if (b > 0) {
          crypto_core_salsa20(x, z, k, sigma);
          for (i = 0; i < b; i++) c[cpos + i] = m[mpos + i] ^ x[i];
        }
        return 0;
      }
      function crypto_stream_salsa20(c, cpos, b, n, k) {
        var z = new Uint8Array(16), x = new Uint8Array(64);
        var u, i;
        for (i = 0; i < 16; i++) z[i] = 0;
        for (i = 0; i < 8; i++) z[i] = n[i];
        while (b >= 64) {
          crypto_core_salsa20(x, z, k, sigma);
          for (i = 0; i < 64; i++) c[cpos + i] = x[i];
          u = 1;
          for (i = 8; i < 16; i++) {
            u = u + (z[i] & 255) | 0;
            z[i] = u & 255;
            u >>>= 8;
          }
          b -= 64;
          cpos += 64;
        }
        if (b > 0) {
          crypto_core_salsa20(x, z, k, sigma);
          for (i = 0; i < b; i++) c[cpos + i] = x[i];
        }
        return 0;
      }
      function crypto_stream(c, cpos, d, n, k) {
        var s = new Uint8Array(32);
        crypto_core_hsalsa20(s, n, k, sigma);
        var sn = new Uint8Array(8);
        for (var i = 0; i < 8; i++) sn[i] = n[i + 16];
        return crypto_stream_salsa20(c, cpos, d, sn, s);
      }
      function crypto_stream_xor(c, cpos, m, mpos, d, n, k) {
        var s = new Uint8Array(32);
        crypto_core_hsalsa20(s, n, k, sigma);
        var sn = new Uint8Array(8);
        for (var i = 0; i < 8; i++) sn[i] = n[i + 16];
        return crypto_stream_salsa20_xor(c, cpos, m, mpos, d, sn, s);
      }
      var poly1305 = function(key) {
        this.buffer = new Uint8Array(16);
        this.r = new Uint16Array(10);
        this.h = new Uint16Array(10);
        this.pad = new Uint16Array(8);
        this.leftover = 0;
        this.fin = 0;
        var t0, t1, t2, t3, t4, t5, t6, t7;
        t0 = key[0] & 255 | (key[1] & 255) << 8;
        this.r[0] = t0 & 8191;
        t1 = key[2] & 255 | (key[3] & 255) << 8;
        this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
        t2 = key[4] & 255 | (key[5] & 255) << 8;
        this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
        t3 = key[6] & 255 | (key[7] & 255) << 8;
        this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
        t4 = key[8] & 255 | (key[9] & 255) << 8;
        this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
        this.r[5] = t4 >>> 1 & 8190;
        t5 = key[10] & 255 | (key[11] & 255) << 8;
        this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
        t6 = key[12] & 255 | (key[13] & 255) << 8;
        this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
        t7 = key[14] & 255 | (key[15] & 255) << 8;
        this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
        this.r[9] = t7 >>> 5 & 127;
        this.pad[0] = key[16] & 255 | (key[17] & 255) << 8;
        this.pad[1] = key[18] & 255 | (key[19] & 255) << 8;
        this.pad[2] = key[20] & 255 | (key[21] & 255) << 8;
        this.pad[3] = key[22] & 255 | (key[23] & 255) << 8;
        this.pad[4] = key[24] & 255 | (key[25] & 255) << 8;
        this.pad[5] = key[26] & 255 | (key[27] & 255) << 8;
        this.pad[6] = key[28] & 255 | (key[29] & 255) << 8;
        this.pad[7] = key[30] & 255 | (key[31] & 255) << 8;
      };
      poly1305.prototype.blocks = function(m, mpos, bytes) {
        var hibit = this.fin ? 0 : 1 << 11;
        var t0, t1, t2, t3, t4, t5, t6, t7, c;
        var d0, d1, d2, d3, d4, d5, d6, d7, d8, d9;
        var h0 = this.h[0], h1 = this.h[1], h2 = this.h[2], h3 = this.h[3], h4 = this.h[4], h5 = this.h[5], h6 = this.h[6], h7 = this.h[7], h8 = this.h[8], h9 = this.h[9];
        var r0 = this.r[0], r1 = this.r[1], r2 = this.r[2], r3 = this.r[3], r4 = this.r[4], r5 = this.r[5], r6 = this.r[6], r7 = this.r[7], r8 = this.r[8], r9 = this.r[9];
        while (bytes >= 16) {
          t0 = m[mpos + 0] & 255 | (m[mpos + 1] & 255) << 8;
          h0 += t0 & 8191;
          t1 = m[mpos + 2] & 255 | (m[mpos + 3] & 255) << 8;
          h1 += (t0 >>> 13 | t1 << 3) & 8191;
          t2 = m[mpos + 4] & 255 | (m[mpos + 5] & 255) << 8;
          h2 += (t1 >>> 10 | t2 << 6) & 8191;
          t3 = m[mpos + 6] & 255 | (m[mpos + 7] & 255) << 8;
          h3 += (t2 >>> 7 | t3 << 9) & 8191;
          t4 = m[mpos + 8] & 255 | (m[mpos + 9] & 255) << 8;
          h4 += (t3 >>> 4 | t4 << 12) & 8191;
          h5 += t4 >>> 1 & 8191;
          t5 = m[mpos + 10] & 255 | (m[mpos + 11] & 255) << 8;
          h6 += (t4 >>> 14 | t5 << 2) & 8191;
          t6 = m[mpos + 12] & 255 | (m[mpos + 13] & 255) << 8;
          h7 += (t5 >>> 11 | t6 << 5) & 8191;
          t7 = m[mpos + 14] & 255 | (m[mpos + 15] & 255) << 8;
          h8 += (t6 >>> 8 | t7 << 8) & 8191;
          h9 += t7 >>> 5 | hibit;
          c = 0;
          d0 = c;
          d0 += h0 * r0;
          d0 += h1 * (5 * r9);
          d0 += h2 * (5 * r8);
          d0 += h3 * (5 * r7);
          d0 += h4 * (5 * r6);
          c = d0 >>> 13;
          d0 &= 8191;
          d0 += h5 * (5 * r5);
          d0 += h6 * (5 * r4);
          d0 += h7 * (5 * r3);
          d0 += h8 * (5 * r2);
          d0 += h9 * (5 * r1);
          c += d0 >>> 13;
          d0 &= 8191;
          d1 = c;
          d1 += h0 * r1;
          d1 += h1 * r0;
          d1 += h2 * (5 * r9);
          d1 += h3 * (5 * r8);
          d1 += h4 * (5 * r7);
          c = d1 >>> 13;
          d1 &= 8191;
          d1 += h5 * (5 * r6);
          d1 += h6 * (5 * r5);
          d1 += h7 * (5 * r4);
          d1 += h8 * (5 * r3);
          d1 += h9 * (5 * r2);
          c += d1 >>> 13;
          d1 &= 8191;
          d2 = c;
          d2 += h0 * r2;
          d2 += h1 * r1;
          d2 += h2 * r0;
          d2 += h3 * (5 * r9);
          d2 += h4 * (5 * r8);
          c = d2 >>> 13;
          d2 &= 8191;
          d2 += h5 * (5 * r7);
          d2 += h6 * (5 * r6);
          d2 += h7 * (5 * r5);
          d2 += h8 * (5 * r4);
          d2 += h9 * (5 * r3);
          c += d2 >>> 13;
          d2 &= 8191;
          d3 = c;
          d3 += h0 * r3;
          d3 += h1 * r2;
          d3 += h2 * r1;
          d3 += h3 * r0;
          d3 += h4 * (5 * r9);
          c = d3 >>> 13;
          d3 &= 8191;
          d3 += h5 * (5 * r8);
          d3 += h6 * (5 * r7);
          d3 += h7 * (5 * r6);
          d3 += h8 * (5 * r5);
          d3 += h9 * (5 * r4);
          c += d3 >>> 13;
          d3 &= 8191;
          d4 = c;
          d4 += h0 * r4;
          d4 += h1 * r3;
          d4 += h2 * r2;
          d4 += h3 * r1;
          d4 += h4 * r0;
          c = d4 >>> 13;
          d4 &= 8191;
          d4 += h5 * (5 * r9);
          d4 += h6 * (5 * r8);
          d4 += h7 * (5 * r7);
          d4 += h8 * (5 * r6);
          d4 += h9 * (5 * r5);
          c += d4 >>> 13;
          d4 &= 8191;
          d5 = c;
          d5 += h0 * r5;
          d5 += h1 * r4;
          d5 += h2 * r3;
          d5 += h3 * r2;
          d5 += h4 * r1;
          c = d5 >>> 13;
          d5 &= 8191;
          d5 += h5 * r0;
          d5 += h6 * (5 * r9);
          d5 += h7 * (5 * r8);
          d5 += h8 * (5 * r7);
          d5 += h9 * (5 * r6);
          c += d5 >>> 13;
          d5 &= 8191;
          d6 = c;
          d6 += h0 * r6;
          d6 += h1 * r5;
          d6 += h2 * r4;
          d6 += h3 * r3;
          d6 += h4 * r2;
          c = d6 >>> 13;
          d6 &= 8191;
          d6 += h5 * r1;
          d6 += h6 * r0;
          d6 += h7 * (5 * r9);
          d6 += h8 * (5 * r8);
          d6 += h9 * (5 * r7);
          c += d6 >>> 13;
          d6 &= 8191;
          d7 = c;
          d7 += h0 * r7;
          d7 += h1 * r6;
          d7 += h2 * r5;
          d7 += h3 * r4;
          d7 += h4 * r3;
          c = d7 >>> 13;
          d7 &= 8191;
          d7 += h5 * r2;
          d7 += h6 * r1;
          d7 += h7 * r0;
          d7 += h8 * (5 * r9);
          d7 += h9 * (5 * r8);
          c += d7 >>> 13;
          d7 &= 8191;
          d8 = c;
          d8 += h0 * r8;
          d8 += h1 * r7;
          d8 += h2 * r6;
          d8 += h3 * r5;
          d8 += h4 * r4;
          c = d8 >>> 13;
          d8 &= 8191;
          d8 += h5 * r3;
          d8 += h6 * r2;
          d8 += h7 * r1;
          d8 += h8 * r0;
          d8 += h9 * (5 * r9);
          c += d8 >>> 13;
          d8 &= 8191;
          d9 = c;
          d9 += h0 * r9;
          d9 += h1 * r8;
          d9 += h2 * r7;
          d9 += h3 * r6;
          d9 += h4 * r5;
          c = d9 >>> 13;
          d9 &= 8191;
          d9 += h5 * r4;
          d9 += h6 * r3;
          d9 += h7 * r2;
          d9 += h8 * r1;
          d9 += h9 * r0;
          c += d9 >>> 13;
          d9 &= 8191;
          c = (c << 2) + c | 0;
          c = c + d0 | 0;
          d0 = c & 8191;
          c = c >>> 13;
          d1 += c;
          h0 = d0;
          h1 = d1;
          h2 = d2;
          h3 = d3;
          h4 = d4;
          h5 = d5;
          h6 = d6;
          h7 = d7;
          h8 = d8;
          h9 = d9;
          mpos += 16;
          bytes -= 16;
        }
        this.h[0] = h0;
        this.h[1] = h1;
        this.h[2] = h2;
        this.h[3] = h3;
        this.h[4] = h4;
        this.h[5] = h5;
        this.h[6] = h6;
        this.h[7] = h7;
        this.h[8] = h8;
        this.h[9] = h9;
      };
      poly1305.prototype.finish = function(mac, macpos) {
        var g = new Uint16Array(10);
        var c, mask, f, i;
        if (this.leftover) {
          i = this.leftover;
          this.buffer[i++] = 1;
          for (; i < 16; i++) this.buffer[i] = 0;
          this.fin = 1;
          this.blocks(this.buffer, 0, 16);
        }
        c = this.h[1] >>> 13;
        this.h[1] &= 8191;
        for (i = 2; i < 10; i++) {
          this.h[i] += c;
          c = this.h[i] >>> 13;
          this.h[i] &= 8191;
        }
        this.h[0] += c * 5;
        c = this.h[0] >>> 13;
        this.h[0] &= 8191;
        this.h[1] += c;
        c = this.h[1] >>> 13;
        this.h[1] &= 8191;
        this.h[2] += c;
        g[0] = this.h[0] + 5;
        c = g[0] >>> 13;
        g[0] &= 8191;
        for (i = 1; i < 10; i++) {
          g[i] = this.h[i] + c;
          c = g[i] >>> 13;
          g[i] &= 8191;
        }
        g[9] -= 1 << 13;
        mask = (c ^ 1) - 1;
        for (i = 0; i < 10; i++) g[i] &= mask;
        mask = ~mask;
        for (i = 0; i < 10; i++) this.h[i] = this.h[i] & mask | g[i];
        this.h[0] = (this.h[0] | this.h[1] << 13) & 65535;
        this.h[1] = (this.h[1] >>> 3 | this.h[2] << 10) & 65535;
        this.h[2] = (this.h[2] >>> 6 | this.h[3] << 7) & 65535;
        this.h[3] = (this.h[3] >>> 9 | this.h[4] << 4) & 65535;
        this.h[4] = (this.h[4] >>> 12 | this.h[5] << 1 | this.h[6] << 14) & 65535;
        this.h[5] = (this.h[6] >>> 2 | this.h[7] << 11) & 65535;
        this.h[6] = (this.h[7] >>> 5 | this.h[8] << 8) & 65535;
        this.h[7] = (this.h[8] >>> 8 | this.h[9] << 5) & 65535;
        f = this.h[0] + this.pad[0];
        this.h[0] = f & 65535;
        for (i = 1; i < 8; i++) {
          f = (this.h[i] + this.pad[i] | 0) + (f >>> 16) | 0;
          this.h[i] = f & 65535;
        }
        mac[macpos + 0] = this.h[0] >>> 0 & 255;
        mac[macpos + 1] = this.h[0] >>> 8 & 255;
        mac[macpos + 2] = this.h[1] >>> 0 & 255;
        mac[macpos + 3] = this.h[1] >>> 8 & 255;
        mac[macpos + 4] = this.h[2] >>> 0 & 255;
        mac[macpos + 5] = this.h[2] >>> 8 & 255;
        mac[macpos + 6] = this.h[3] >>> 0 & 255;
        mac[macpos + 7] = this.h[3] >>> 8 & 255;
        mac[macpos + 8] = this.h[4] >>> 0 & 255;
        mac[macpos + 9] = this.h[4] >>> 8 & 255;
        mac[macpos + 10] = this.h[5] >>> 0 & 255;
        mac[macpos + 11] = this.h[5] >>> 8 & 255;
        mac[macpos + 12] = this.h[6] >>> 0 & 255;
        mac[macpos + 13] = this.h[6] >>> 8 & 255;
        mac[macpos + 14] = this.h[7] >>> 0 & 255;
        mac[macpos + 15] = this.h[7] >>> 8 & 255;
      };
      poly1305.prototype.update = function(m, mpos, bytes) {
        var i, want;
        if (this.leftover) {
          want = 16 - this.leftover;
          if (want > bytes)
            want = bytes;
          for (i = 0; i < want; i++)
            this.buffer[this.leftover + i] = m[mpos + i];
          bytes -= want;
          mpos += want;
          this.leftover += want;
          if (this.leftover < 16)
            return;
          this.blocks(this.buffer, 0, 16);
          this.leftover = 0;
        }
        if (bytes >= 16) {
          want = bytes - bytes % 16;
          this.blocks(m, mpos, want);
          mpos += want;
          bytes -= want;
        }
        if (bytes) {
          for (i = 0; i < bytes; i++)
            this.buffer[this.leftover + i] = m[mpos + i];
          this.leftover += bytes;
        }
      };
      function crypto_onetimeauth(out, outpos, m, mpos, n, k) {
        var s = new poly1305(k);
        s.update(m, mpos, n);
        s.finish(out, outpos);
        return 0;
      }
      function crypto_onetimeauth_verify(h, hpos, m, mpos, n, k) {
        var x = new Uint8Array(16);
        crypto_onetimeauth(x, 0, m, mpos, n, k);
        return crypto_verify_16(h, hpos, x, 0);
      }
      function crypto_secretbox(c, m, d, n, k) {
        var i;
        if (d < 32) return -1;
        crypto_stream_xor(c, 0, m, 0, d, n, k);
        crypto_onetimeauth(c, 16, c, 32, d - 32, c);
        for (i = 0; i < 16; i++) c[i] = 0;
        return 0;
      }
      function crypto_secretbox_open(m, c, d, n, k) {
        var i;
        var x = new Uint8Array(32);
        if (d < 32) return -1;
        crypto_stream(x, 0, 32, n, k);
        if (crypto_onetimeauth_verify(c, 16, c, 32, d - 32, x) !== 0) return -1;
        crypto_stream_xor(m, 0, c, 0, d, n, k);
        for (i = 0; i < 32; i++) m[i] = 0;
        return 0;
      }
      function set25519(r, a) {
        var i;
        for (i = 0; i < 16; i++) r[i] = a[i] | 0;
      }
      function car25519(o) {
        var i, v, c = 1;
        for (i = 0; i < 16; i++) {
          v = o[i] + c + 65535;
          c = Math.floor(v / 65536);
          o[i] = v - c * 65536;
        }
        o[0] += c - 1 + 37 * (c - 1);
      }
      function sel25519(p, q, b) {
        var t, c = ~(b - 1);
        for (var i = 0; i < 16; i++) {
          t = c & (p[i] ^ q[i]);
          p[i] ^= t;
          q[i] ^= t;
        }
      }
      function pack25519(o, n) {
        var i, j, b;
        var m = gf(), t = gf();
        for (i = 0; i < 16; i++) t[i] = n[i];
        car25519(t);
        car25519(t);
        car25519(t);
        for (j = 0; j < 2; j++) {
          m[0] = t[0] - 65517;
          for (i = 1; i < 15; i++) {
            m[i] = t[i] - 65535 - (m[i - 1] >> 16 & 1);
            m[i - 1] &= 65535;
          }
          m[15] = t[15] - 32767 - (m[14] >> 16 & 1);
          b = m[15] >> 16 & 1;
          m[14] &= 65535;
          sel25519(t, m, 1 - b);
        }
        for (i = 0; i < 16; i++) {
          o[2 * i] = t[i] & 255;
          o[2 * i + 1] = t[i] >> 8;
        }
      }
      function neq25519(a, b) {
        var c = new Uint8Array(32), d = new Uint8Array(32);
        pack25519(c, a);
        pack25519(d, b);
        return crypto_verify_32(c, 0, d, 0);
      }
      function par25519(a) {
        var d = new Uint8Array(32);
        pack25519(d, a);
        return d[0] & 1;
      }
      function unpack25519(o, n) {
        var i;
        for (i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
        o[15] &= 32767;
      }
      function A2(o, a, b) {
        for (var i = 0; i < 16; i++) o[i] = a[i] + b[i];
      }
      function Z(o, a, b) {
        for (var i = 0; i < 16; i++) o[i] = a[i] - b[i];
      }
      function M(o, a, b) {
        var v, c, t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0, t5 = 0, t6 = 0, t7 = 0, t8 = 0, t9 = 0, t10 = 0, t11 = 0, t12 = 0, t13 = 0, t14 = 0, t15 = 0, t16 = 0, t17 = 0, t18 = 0, t19 = 0, t20 = 0, t21 = 0, t22 = 0, t23 = 0, t24 = 0, t25 = 0, t26 = 0, t27 = 0, t28 = 0, t29 = 0, t30 = 0, b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7], b8 = b[8], b9 = b[9], b10 = b[10], b11 = b[11], b12 = b[12], b13 = b[13], b14 = b[14], b15 = b[15];
        v = a[0];
        t0 += v * b0;
        t1 += v * b1;
        t2 += v * b2;
        t3 += v * b3;
        t4 += v * b4;
        t5 += v * b5;
        t6 += v * b6;
        t7 += v * b7;
        t8 += v * b8;
        t9 += v * b9;
        t10 += v * b10;
        t11 += v * b11;
        t12 += v * b12;
        t13 += v * b13;
        t14 += v * b14;
        t15 += v * b15;
        v = a[1];
        t1 += v * b0;
        t2 += v * b1;
        t3 += v * b2;
        t4 += v * b3;
        t5 += v * b4;
        t6 += v * b5;
        t7 += v * b6;
        t8 += v * b7;
        t9 += v * b8;
        t10 += v * b9;
        t11 += v * b10;
        t12 += v * b11;
        t13 += v * b12;
        t14 += v * b13;
        t15 += v * b14;
        t16 += v * b15;
        v = a[2];
        t2 += v * b0;
        t3 += v * b1;
        t4 += v * b2;
        t5 += v * b3;
        t6 += v * b4;
        t7 += v * b5;
        t8 += v * b6;
        t9 += v * b7;
        t10 += v * b8;
        t11 += v * b9;
        t12 += v * b10;
        t13 += v * b11;
        t14 += v * b12;
        t15 += v * b13;
        t16 += v * b14;
        t17 += v * b15;
        v = a[3];
        t3 += v * b0;
        t4 += v * b1;
        t5 += v * b2;
        t6 += v * b3;
        t7 += v * b4;
        t8 += v * b5;
        t9 += v * b6;
        t10 += v * b7;
        t11 += v * b8;
        t12 += v * b9;
        t13 += v * b10;
        t14 += v * b11;
        t15 += v * b12;
        t16 += v * b13;
        t17 += v * b14;
        t18 += v * b15;
        v = a[4];
        t4 += v * b0;
        t5 += v * b1;
        t6 += v * b2;
        t7 += v * b3;
        t8 += v * b4;
        t9 += v * b5;
        t10 += v * b6;
        t11 += v * b7;
        t12 += v * b8;
        t13 += v * b9;
        t14 += v * b10;
        t15 += v * b11;
        t16 += v * b12;
        t17 += v * b13;
        t18 += v * b14;
        t19 += v * b15;
        v = a[5];
        t5 += v * b0;
        t6 += v * b1;
        t7 += v * b2;
        t8 += v * b3;
        t9 += v * b4;
        t10 += v * b5;
        t11 += v * b6;
        t12 += v * b7;
        t13 += v * b8;
        t14 += v * b9;
        t15 += v * b10;
        t16 += v * b11;
        t17 += v * b12;
        t18 += v * b13;
        t19 += v * b14;
        t20 += v * b15;
        v = a[6];
        t6 += v * b0;
        t7 += v * b1;
        t8 += v * b2;
        t9 += v * b3;
        t10 += v * b4;
        t11 += v * b5;
        t12 += v * b6;
        t13 += v * b7;
        t14 += v * b8;
        t15 += v * b9;
        t16 += v * b10;
        t17 += v * b11;
        t18 += v * b12;
        t19 += v * b13;
        t20 += v * b14;
        t21 += v * b15;
        v = a[7];
        t7 += v * b0;
        t8 += v * b1;
        t9 += v * b2;
        t10 += v * b3;
        t11 += v * b4;
        t12 += v * b5;
        t13 += v * b6;
        t14 += v * b7;
        t15 += v * b8;
        t16 += v * b9;
        t17 += v * b10;
        t18 += v * b11;
        t19 += v * b12;
        t20 += v * b13;
        t21 += v * b14;
        t22 += v * b15;
        v = a[8];
        t8 += v * b0;
        t9 += v * b1;
        t10 += v * b2;
        t11 += v * b3;
        t12 += v * b4;
        t13 += v * b5;
        t14 += v * b6;
        t15 += v * b7;
        t16 += v * b8;
        t17 += v * b9;
        t18 += v * b10;
        t19 += v * b11;
        t20 += v * b12;
        t21 += v * b13;
        t22 += v * b14;
        t23 += v * b15;
        v = a[9];
        t9 += v * b0;
        t10 += v * b1;
        t11 += v * b2;
        t12 += v * b3;
        t13 += v * b4;
        t14 += v * b5;
        t15 += v * b6;
        t16 += v * b7;
        t17 += v * b8;
        t18 += v * b9;
        t19 += v * b10;
        t20 += v * b11;
        t21 += v * b12;
        t22 += v * b13;
        t23 += v * b14;
        t24 += v * b15;
        v = a[10];
        t10 += v * b0;
        t11 += v * b1;
        t12 += v * b2;
        t13 += v * b3;
        t14 += v * b4;
        t15 += v * b5;
        t16 += v * b6;
        t17 += v * b7;
        t18 += v * b8;
        t19 += v * b9;
        t20 += v * b10;
        t21 += v * b11;
        t22 += v * b12;
        t23 += v * b13;
        t24 += v * b14;
        t25 += v * b15;
        v = a[11];
        t11 += v * b0;
        t12 += v * b1;
        t13 += v * b2;
        t14 += v * b3;
        t15 += v * b4;
        t16 += v * b5;
        t17 += v * b6;
        t18 += v * b7;
        t19 += v * b8;
        t20 += v * b9;
        t21 += v * b10;
        t22 += v * b11;
        t23 += v * b12;
        t24 += v * b13;
        t25 += v * b14;
        t26 += v * b15;
        v = a[12];
        t12 += v * b0;
        t13 += v * b1;
        t14 += v * b2;
        t15 += v * b3;
        t16 += v * b4;
        t17 += v * b5;
        t18 += v * b6;
        t19 += v * b7;
        t20 += v * b8;
        t21 += v * b9;
        t22 += v * b10;
        t23 += v * b11;
        t24 += v * b12;
        t25 += v * b13;
        t26 += v * b14;
        t27 += v * b15;
        v = a[13];
        t13 += v * b0;
        t14 += v * b1;
        t15 += v * b2;
        t16 += v * b3;
        t17 += v * b4;
        t18 += v * b5;
        t19 += v * b6;
        t20 += v * b7;
        t21 += v * b8;
        t22 += v * b9;
        t23 += v * b10;
        t24 += v * b11;
        t25 += v * b12;
        t26 += v * b13;
        t27 += v * b14;
        t28 += v * b15;
        v = a[14];
        t14 += v * b0;
        t15 += v * b1;
        t16 += v * b2;
        t17 += v * b3;
        t18 += v * b4;
        t19 += v * b5;
        t20 += v * b6;
        t21 += v * b7;
        t22 += v * b8;
        t23 += v * b9;
        t24 += v * b10;
        t25 += v * b11;
        t26 += v * b12;
        t27 += v * b13;
        t28 += v * b14;
        t29 += v * b15;
        v = a[15];
        t15 += v * b0;
        t16 += v * b1;
        t17 += v * b2;
        t18 += v * b3;
        t19 += v * b4;
        t20 += v * b5;
        t21 += v * b6;
        t22 += v * b7;
        t23 += v * b8;
        t24 += v * b9;
        t25 += v * b10;
        t26 += v * b11;
        t27 += v * b12;
        t28 += v * b13;
        t29 += v * b14;
        t30 += v * b15;
        t0 += 38 * t16;
        t1 += 38 * t17;
        t2 += 38 * t18;
        t3 += 38 * t19;
        t4 += 38 * t20;
        t5 += 38 * t21;
        t6 += 38 * t22;
        t7 += 38 * t23;
        t8 += 38 * t24;
        t9 += 38 * t25;
        t10 += 38 * t26;
        t11 += 38 * t27;
        t12 += 38 * t28;
        t13 += 38 * t29;
        t14 += 38 * t30;
        c = 1;
        v = t0 + c + 65535;
        c = Math.floor(v / 65536);
        t0 = v - c * 65536;
        v = t1 + c + 65535;
        c = Math.floor(v / 65536);
        t1 = v - c * 65536;
        v = t2 + c + 65535;
        c = Math.floor(v / 65536);
        t2 = v - c * 65536;
        v = t3 + c + 65535;
        c = Math.floor(v / 65536);
        t3 = v - c * 65536;
        v = t4 + c + 65535;
        c = Math.floor(v / 65536);
        t4 = v - c * 65536;
        v = t5 + c + 65535;
        c = Math.floor(v / 65536);
        t5 = v - c * 65536;
        v = t6 + c + 65535;
        c = Math.floor(v / 65536);
        t6 = v - c * 65536;
        v = t7 + c + 65535;
        c = Math.floor(v / 65536);
        t7 = v - c * 65536;
        v = t8 + c + 65535;
        c = Math.floor(v / 65536);
        t8 = v - c * 65536;
        v = t9 + c + 65535;
        c = Math.floor(v / 65536);
        t9 = v - c * 65536;
        v = t10 + c + 65535;
        c = Math.floor(v / 65536);
        t10 = v - c * 65536;
        v = t11 + c + 65535;
        c = Math.floor(v / 65536);
        t11 = v - c * 65536;
        v = t12 + c + 65535;
        c = Math.floor(v / 65536);
        t12 = v - c * 65536;
        v = t13 + c + 65535;
        c = Math.floor(v / 65536);
        t13 = v - c * 65536;
        v = t14 + c + 65535;
        c = Math.floor(v / 65536);
        t14 = v - c * 65536;
        v = t15 + c + 65535;
        c = Math.floor(v / 65536);
        t15 = v - c * 65536;
        t0 += c - 1 + 37 * (c - 1);
        c = 1;
        v = t0 + c + 65535;
        c = Math.floor(v / 65536);
        t0 = v - c * 65536;
        v = t1 + c + 65535;
        c = Math.floor(v / 65536);
        t1 = v - c * 65536;
        v = t2 + c + 65535;
        c = Math.floor(v / 65536);
        t2 = v - c * 65536;
        v = t3 + c + 65535;
        c = Math.floor(v / 65536);
        t3 = v - c * 65536;
        v = t4 + c + 65535;
        c = Math.floor(v / 65536);
        t4 = v - c * 65536;
        v = t5 + c + 65535;
        c = Math.floor(v / 65536);
        t5 = v - c * 65536;
        v = t6 + c + 65535;
        c = Math.floor(v / 65536);
        t6 = v - c * 65536;
        v = t7 + c + 65535;
        c = Math.floor(v / 65536);
        t7 = v - c * 65536;
        v = t8 + c + 65535;
        c = Math.floor(v / 65536);
        t8 = v - c * 65536;
        v = t9 + c + 65535;
        c = Math.floor(v / 65536);
        t9 = v - c * 65536;
        v = t10 + c + 65535;
        c = Math.floor(v / 65536);
        t10 = v - c * 65536;
        v = t11 + c + 65535;
        c = Math.floor(v / 65536);
        t11 = v - c * 65536;
        v = t12 + c + 65535;
        c = Math.floor(v / 65536);
        t12 = v - c * 65536;
        v = t13 + c + 65535;
        c = Math.floor(v / 65536);
        t13 = v - c * 65536;
        v = t14 + c + 65535;
        c = Math.floor(v / 65536);
        t14 = v - c * 65536;
        v = t15 + c + 65535;
        c = Math.floor(v / 65536);
        t15 = v - c * 65536;
        t0 += c - 1 + 37 * (c - 1);
        o[0] = t0;
        o[1] = t1;
        o[2] = t2;
        o[3] = t3;
        o[4] = t4;
        o[5] = t5;
        o[6] = t6;
        o[7] = t7;
        o[8] = t8;
        o[9] = t9;
        o[10] = t10;
        o[11] = t11;
        o[12] = t12;
        o[13] = t13;
        o[14] = t14;
        o[15] = t15;
      }
      function S2(o, a) {
        M(o, a, a);
      }
      function inv25519(o, i) {
        var c = gf();
        var a;
        for (a = 0; a < 16; a++) c[a] = i[a];
        for (a = 253; a >= 0; a--) {
          S2(c, c);
          if (a !== 2 && a !== 4) M(c, c, i);
        }
        for (a = 0; a < 16; a++) o[a] = c[a];
      }
      function pow2523(o, i) {
        var c = gf();
        var a;
        for (a = 0; a < 16; a++) c[a] = i[a];
        for (a = 250; a >= 0; a--) {
          S2(c, c);
          if (a !== 1) M(c, c, i);
        }
        for (a = 0; a < 16; a++) o[a] = c[a];
      }
      function crypto_scalarmult(q, n, p) {
        var z = new Uint8Array(32);
        var x = new Float64Array(80), r, i;
        var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf();
        for (i = 0; i < 31; i++) z[i] = n[i];
        z[31] = n[31] & 127 | 64;
        z[0] &= 248;
        unpack25519(x, p);
        for (i = 0; i < 16; i++) {
          b[i] = x[i];
          d[i] = a[i] = c[i] = 0;
        }
        a[0] = d[0] = 1;
        for (i = 254; i >= 0; --i) {
          r = z[i >>> 3] >>> (i & 7) & 1;
          sel25519(a, b, r);
          sel25519(c, d, r);
          A2(e, a, c);
          Z(a, a, c);
          A2(c, b, d);
          Z(b, b, d);
          S2(d, e);
          S2(f, a);
          M(a, c, a);
          M(c, b, e);
          A2(e, a, c);
          Z(a, a, c);
          S2(b, a);
          Z(c, d, f);
          M(a, c, _121665);
          A2(a, a, d);
          M(c, c, a);
          M(a, d, f);
          M(d, b, x);
          S2(b, e);
          sel25519(a, b, r);
          sel25519(c, d, r);
        }
        for (i = 0; i < 16; i++) {
          x[i + 16] = a[i];
          x[i + 32] = c[i];
          x[i + 48] = b[i];
          x[i + 64] = d[i];
        }
        var x32 = x.subarray(32);
        var x16 = x.subarray(16);
        inv25519(x32, x32);
        M(x16, x16, x32);
        pack25519(q, x16);
        return 0;
      }
      function crypto_scalarmult_base(q, n) {
        return crypto_scalarmult(q, n, _9);
      }
      function crypto_box_keypair(y, x) {
        randombytes(x, 32);
        return crypto_scalarmult_base(y, x);
      }
      function crypto_box_beforenm(k, y, x) {
        var s = new Uint8Array(32);
        crypto_scalarmult(s, x, y);
        return crypto_core_hsalsa20(k, _0, s, sigma);
      }
      var crypto_box_afternm = crypto_secretbox;
      var crypto_box_open_afternm = crypto_secretbox_open;
      function crypto_box(c, m, d, n, y, x) {
        var k = new Uint8Array(32);
        crypto_box_beforenm(k, y, x);
        return crypto_box_afternm(c, m, d, n, k);
      }
      function crypto_box_open(m, c, d, n, y, x) {
        var k = new Uint8Array(32);
        crypto_box_beforenm(k, y, x);
        return crypto_box_open_afternm(m, c, d, n, k);
      }
      var K = [
        1116352408,
        3609767458,
        1899447441,
        602891725,
        3049323471,
        3964484399,
        3921009573,
        2173295548,
        961987163,
        4081628472,
        1508970993,
        3053834265,
        2453635748,
        2937671579,
        2870763221,
        3664609560,
        3624381080,
        2734883394,
        310598401,
        1164996542,
        607225278,
        1323610764,
        1426881987,
        3590304994,
        1925078388,
        4068182383,
        2162078206,
        991336113,
        2614888103,
        633803317,
        3248222580,
        3479774868,
        3835390401,
        2666613458,
        4022224774,
        944711139,
        264347078,
        2341262773,
        604807628,
        2007800933,
        770255983,
        1495990901,
        1249150122,
        1856431235,
        1555081692,
        3175218132,
        1996064986,
        2198950837,
        2554220882,
        3999719339,
        2821834349,
        766784016,
        2952996808,
        2566594879,
        3210313671,
        3203337956,
        3336571891,
        1034457026,
        3584528711,
        2466948901,
        113926993,
        3758326383,
        338241895,
        168717936,
        666307205,
        1188179964,
        773529912,
        1546045734,
        1294757372,
        1522805485,
        1396182291,
        2643833823,
        1695183700,
        2343527390,
        1986661051,
        1014477480,
        2177026350,
        1206759142,
        2456956037,
        344077627,
        2730485921,
        1290863460,
        2820302411,
        3158454273,
        3259730800,
        3505952657,
        3345764771,
        106217008,
        3516065817,
        3606008344,
        3600352804,
        1432725776,
        4094571909,
        1467031594,
        275423344,
        851169720,
        430227734,
        3100823752,
        506948616,
        1363258195,
        659060556,
        3750685593,
        883997877,
        3785050280,
        958139571,
        3318307427,
        1322822218,
        3812723403,
        1537002063,
        2003034995,
        1747873779,
        3602036899,
        1955562222,
        1575990012,
        2024104815,
        1125592928,
        2227730452,
        2716904306,
        2361852424,
        442776044,
        2428436474,
        593698344,
        2756734187,
        3733110249,
        3204031479,
        2999351573,
        3329325298,
        3815920427,
        3391569614,
        3928383900,
        3515267271,
        566280711,
        3940187606,
        3454069534,
        4118630271,
        4000239992,
        116418474,
        1914138554,
        174292421,
        2731055270,
        289380356,
        3203993006,
        460393269,
        320620315,
        685471733,
        587496836,
        852142971,
        1086792851,
        1017036298,
        365543100,
        1126000580,
        2618297676,
        1288033470,
        3409855158,
        1501505948,
        4234509866,
        1607167915,
        987167468,
        1816402316,
        1246189591
      ];
      function crypto_hashblocks_hl(hh, hl, m, n) {
        var wh = new Int32Array(16), wl = new Int32Array(16), bh0, bh1, bh2, bh3, bh4, bh5, bh6, bh7, bl0, bl1, bl2, bl3, bl4, bl5, bl6, bl7, th, tl, i, j, h, l, a, b, c, d;
        var ah0 = hh[0], ah1 = hh[1], ah2 = hh[2], ah3 = hh[3], ah4 = hh[4], ah5 = hh[5], ah6 = hh[6], ah7 = hh[7], al0 = hl[0], al1 = hl[1], al2 = hl[2], al3 = hl[3], al4 = hl[4], al5 = hl[5], al6 = hl[6], al7 = hl[7];
        var pos = 0;
        while (n >= 128) {
          for (i = 0; i < 16; i++) {
            j = 8 * i + pos;
            wh[i] = m[j + 0] << 24 | m[j + 1] << 16 | m[j + 2] << 8 | m[j + 3];
            wl[i] = m[j + 4] << 24 | m[j + 5] << 16 | m[j + 6] << 8 | m[j + 7];
          }
          for (i = 0; i < 80; i++) {
            bh0 = ah0;
            bh1 = ah1;
            bh2 = ah2;
            bh3 = ah3;
            bh4 = ah4;
            bh5 = ah5;
            bh6 = ah6;
            bh7 = ah7;
            bl0 = al0;
            bl1 = al1;
            bl2 = al2;
            bl3 = al3;
            bl4 = al4;
            bl5 = al5;
            bl6 = al6;
            bl7 = al7;
            h = ah7;
            l = al7;
            a = l & 65535;
            b = l >>> 16;
            c = h & 65535;
            d = h >>> 16;
            h = (ah4 >>> 14 | al4 << 32 - 14) ^ (ah4 >>> 18 | al4 << 32 - 18) ^ (al4 >>> 41 - 32 | ah4 << 32 - (41 - 32));
            l = (al4 >>> 14 | ah4 << 32 - 14) ^ (al4 >>> 18 | ah4 << 32 - 18) ^ (ah4 >>> 41 - 32 | al4 << 32 - (41 - 32));
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            h = ah4 & ah5 ^ ~ah4 & ah6;
            l = al4 & al5 ^ ~al4 & al6;
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            h = K[i * 2];
            l = K[i * 2 + 1];
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            h = wh[i % 16];
            l = wl[i % 16];
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            b += a >>> 16;
            c += b >>> 16;
            d += c >>> 16;
            th = c & 65535 | d << 16;
            tl = a & 65535 | b << 16;
            h = th;
            l = tl;
            a = l & 65535;
            b = l >>> 16;
            c = h & 65535;
            d = h >>> 16;
            h = (ah0 >>> 28 | al0 << 32 - 28) ^ (al0 >>> 34 - 32 | ah0 << 32 - (34 - 32)) ^ (al0 >>> 39 - 32 | ah0 << 32 - (39 - 32));
            l = (al0 >>> 28 | ah0 << 32 - 28) ^ (ah0 >>> 34 - 32 | al0 << 32 - (34 - 32)) ^ (ah0 >>> 39 - 32 | al0 << 32 - (39 - 32));
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            h = ah0 & ah1 ^ ah0 & ah2 ^ ah1 & ah2;
            l = al0 & al1 ^ al0 & al2 ^ al1 & al2;
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            b += a >>> 16;
            c += b >>> 16;
            d += c >>> 16;
            bh7 = c & 65535 | d << 16;
            bl7 = a & 65535 | b << 16;
            h = bh3;
            l = bl3;
            a = l & 65535;
            b = l >>> 16;
            c = h & 65535;
            d = h >>> 16;
            h = th;
            l = tl;
            a += l & 65535;
            b += l >>> 16;
            c += h & 65535;
            d += h >>> 16;
            b += a >>> 16;
            c += b >>> 16;
            d += c >>> 16;
            bh3 = c & 65535 | d << 16;
            bl3 = a & 65535 | b << 16;
            ah1 = bh0;
            ah2 = bh1;
            ah3 = bh2;
            ah4 = bh3;
            ah5 = bh4;
            ah6 = bh5;
            ah7 = bh6;
            ah0 = bh7;
            al1 = bl0;
            al2 = bl1;
            al3 = bl2;
            al4 = bl3;
            al5 = bl4;
            al6 = bl5;
            al7 = bl6;
            al0 = bl7;
            if (i % 16 === 15) {
              for (j = 0; j < 16; j++) {
                h = wh[j];
                l = wl[j];
                a = l & 65535;
                b = l >>> 16;
                c = h & 65535;
                d = h >>> 16;
                h = wh[(j + 9) % 16];
                l = wl[(j + 9) % 16];
                a += l & 65535;
                b += l >>> 16;
                c += h & 65535;
                d += h >>> 16;
                th = wh[(j + 1) % 16];
                tl = wl[(j + 1) % 16];
                h = (th >>> 1 | tl << 32 - 1) ^ (th >>> 8 | tl << 32 - 8) ^ th >>> 7;
                l = (tl >>> 1 | th << 32 - 1) ^ (tl >>> 8 | th << 32 - 8) ^ (tl >>> 7 | th << 32 - 7);
                a += l & 65535;
                b += l >>> 16;
                c += h & 65535;
                d += h >>> 16;
                th = wh[(j + 14) % 16];
                tl = wl[(j + 14) % 16];
                h = (th >>> 19 | tl << 32 - 19) ^ (tl >>> 61 - 32 | th << 32 - (61 - 32)) ^ th >>> 6;
                l = (tl >>> 19 | th << 32 - 19) ^ (th >>> 61 - 32 | tl << 32 - (61 - 32)) ^ (tl >>> 6 | th << 32 - 6);
                a += l & 65535;
                b += l >>> 16;
                c += h & 65535;
                d += h >>> 16;
                b += a >>> 16;
                c += b >>> 16;
                d += c >>> 16;
                wh[j] = c & 65535 | d << 16;
                wl[j] = a & 65535 | b << 16;
              }
            }
          }
          h = ah0;
          l = al0;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[0];
          l = hl[0];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[0] = ah0 = c & 65535 | d << 16;
          hl[0] = al0 = a & 65535 | b << 16;
          h = ah1;
          l = al1;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[1];
          l = hl[1];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[1] = ah1 = c & 65535 | d << 16;
          hl[1] = al1 = a & 65535 | b << 16;
          h = ah2;
          l = al2;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[2];
          l = hl[2];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[2] = ah2 = c & 65535 | d << 16;
          hl[2] = al2 = a & 65535 | b << 16;
          h = ah3;
          l = al3;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[3];
          l = hl[3];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[3] = ah3 = c & 65535 | d << 16;
          hl[3] = al3 = a & 65535 | b << 16;
          h = ah4;
          l = al4;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[4];
          l = hl[4];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[4] = ah4 = c & 65535 | d << 16;
          hl[4] = al4 = a & 65535 | b << 16;
          h = ah5;
          l = al5;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[5];
          l = hl[5];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[5] = ah5 = c & 65535 | d << 16;
          hl[5] = al5 = a & 65535 | b << 16;
          h = ah6;
          l = al6;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[6];
          l = hl[6];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[6] = ah6 = c & 65535 | d << 16;
          hl[6] = al6 = a & 65535 | b << 16;
          h = ah7;
          l = al7;
          a = l & 65535;
          b = l >>> 16;
          c = h & 65535;
          d = h >>> 16;
          h = hh[7];
          l = hl[7];
          a += l & 65535;
          b += l >>> 16;
          c += h & 65535;
          d += h >>> 16;
          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;
          hh[7] = ah7 = c & 65535 | d << 16;
          hl[7] = al7 = a & 65535 | b << 16;
          pos += 128;
          n -= 128;
        }
        return n;
      }
      function crypto_hash(out, m, n) {
        var hh = new Int32Array(8), hl = new Int32Array(8), x = new Uint8Array(256), i, b = n;
        hh[0] = 1779033703;
        hh[1] = 3144134277;
        hh[2] = 1013904242;
        hh[3] = 2773480762;
        hh[4] = 1359893119;
        hh[5] = 2600822924;
        hh[6] = 528734635;
        hh[7] = 1541459225;
        hl[0] = 4089235720;
        hl[1] = 2227873595;
        hl[2] = 4271175723;
        hl[3] = 1595750129;
        hl[4] = 2917565137;
        hl[5] = 725511199;
        hl[6] = 4215389547;
        hl[7] = 327033209;
        crypto_hashblocks_hl(hh, hl, m, n);
        n %= 128;
        for (i = 0; i < n; i++) x[i] = m[b - n + i];
        x[n] = 128;
        n = 256 - 128 * (n < 112 ? 1 : 0);
        x[n - 9] = 0;
        ts64(x, n - 8, b / 536870912 | 0, b << 3);
        crypto_hashblocks_hl(hh, hl, x, n);
        for (i = 0; i < 8; i++) ts64(out, 8 * i, hh[i], hl[i]);
        return 0;
      }
      function add2(p, q) {
        var a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf(), g = gf(), h = gf(), t = gf();
        Z(a, p[1], p[0]);
        Z(t, q[1], q[0]);
        M(a, a, t);
        A2(b, p[0], p[1]);
        A2(t, q[0], q[1]);
        M(b, b, t);
        M(c, p[3], q[3]);
        M(c, c, D22);
        M(d, p[2], q[2]);
        A2(d, d, d);
        Z(e, b, a);
        Z(f, d, c);
        A2(g, d, c);
        A2(h, b, a);
        M(p[0], e, f);
        M(p[1], h, g);
        M(p[2], g, f);
        M(p[3], e, h);
      }
      function cswap(p, q, b) {
        var i;
        for (i = 0; i < 4; i++) {
          sel25519(p[i], q[i], b);
        }
      }
      function pack(r, p) {
        var tx = gf(), ty = gf(), zi = gf();
        inv25519(zi, p[2]);
        M(tx, p[0], zi);
        M(ty, p[1], zi);
        pack25519(r, ty);
        r[31] ^= par25519(tx) << 7;
      }
      function scalarmult(p, q, s) {
        var b, i;
        set25519(p[0], gf0);
        set25519(p[1], gf1);
        set25519(p[2], gf1);
        set25519(p[3], gf0);
        for (i = 255; i >= 0; --i) {
          b = s[i / 8 | 0] >> (i & 7) & 1;
          cswap(p, q, b);
          add2(q, p);
          add2(p, p);
          cswap(p, q, b);
        }
      }
      function scalarbase(p, s) {
        var q = [gf(), gf(), gf(), gf()];
        set25519(q[0], X);
        set25519(q[1], Y);
        set25519(q[2], gf1);
        M(q[3], X, Y);
        scalarmult(p, q, s);
      }
      function crypto_sign_keypair(pk, sk, seeded) {
        var d = new Uint8Array(64);
        var p = [gf(), gf(), gf(), gf()];
        var i;
        if (!seeded) randombytes(sk, 32);
        crypto_hash(d, sk, 32);
        d[0] &= 248;
        d[31] &= 127;
        d[31] |= 64;
        scalarbase(p, d);
        pack(pk, p);
        for (i = 0; i < 32; i++) sk[i + 32] = pk[i];
        return 0;
      }
      var L = new Float64Array([237, 211, 245, 92, 26, 99, 18, 88, 214, 156, 247, 162, 222, 249, 222, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16]);
      function modL(r, x) {
        var carry, i, j, k;
        for (i = 63; i >= 32; --i) {
          carry = 0;
          for (j = i - 32, k = i - 12; j < k; ++j) {
            x[j] += carry - 16 * x[i] * L[j - (i - 32)];
            carry = Math.floor((x[j] + 128) / 256);
            x[j] -= carry * 256;
          }
          x[j] += carry;
          x[i] = 0;
        }
        carry = 0;
        for (j = 0; j < 32; j++) {
          x[j] += carry - (x[31] >> 4) * L[j];
          carry = x[j] >> 8;
          x[j] &= 255;
        }
        for (j = 0; j < 32; j++) x[j] -= carry * L[j];
        for (i = 0; i < 32; i++) {
          x[i + 1] += x[i] >> 8;
          r[i] = x[i] & 255;
        }
      }
      function reduce2(r) {
        var x = new Float64Array(64), i;
        for (i = 0; i < 64; i++) x[i] = r[i];
        for (i = 0; i < 64; i++) r[i] = 0;
        modL(r, x);
      }
      function crypto_sign(sm, m, n, sk) {
        var d = new Uint8Array(64), h = new Uint8Array(64), r = new Uint8Array(64);
        var i, j, x = new Float64Array(64);
        var p = [gf(), gf(), gf(), gf()];
        crypto_hash(d, sk, 32);
        d[0] &= 248;
        d[31] &= 127;
        d[31] |= 64;
        var smlen = n + 64;
        for (i = 0; i < n; i++) sm[64 + i] = m[i];
        for (i = 0; i < 32; i++) sm[32 + i] = d[32 + i];
        crypto_hash(r, sm.subarray(32), n + 32);
        reduce2(r);
        scalarbase(p, r);
        pack(sm, p);
        for (i = 32; i < 64; i++) sm[i] = sk[i];
        crypto_hash(h, sm, n + 64);
        reduce2(h);
        for (i = 0; i < 64; i++) x[i] = 0;
        for (i = 0; i < 32; i++) x[i] = r[i];
        for (i = 0; i < 32; i++) {
          for (j = 0; j < 32; j++) {
            x[i + j] += h[i] * d[j];
          }
        }
        modL(sm.subarray(32), x);
        return smlen;
      }
      function unpackneg(r, p) {
        var t = gf(), chk = gf(), num = gf(), den = gf(), den2 = gf(), den4 = gf(), den6 = gf();
        set25519(r[2], gf1);
        unpack25519(r[1], p);
        S2(num, r[1]);
        M(den, num, D2);
        Z(num, num, r[2]);
        A2(den, r[2], den);
        S2(den2, den);
        S2(den4, den2);
        M(den6, den4, den2);
        M(t, den6, num);
        M(t, t, den);
        pow2523(t, t);
        M(t, t, num);
        M(t, t, den);
        M(t, t, den);
        M(r[0], t, den);
        S2(chk, r[0]);
        M(chk, chk, den);
        if (neq25519(chk, num)) M(r[0], r[0], I);
        S2(chk, r[0]);
        M(chk, chk, den);
        if (neq25519(chk, num)) return -1;
        if (par25519(r[0]) === p[31] >> 7) Z(r[0], gf0, r[0]);
        M(r[3], r[0], r[1]);
        return 0;
      }
      function crypto_sign_open(m, sm, n, pk) {
        var i;
        var t = new Uint8Array(32), h = new Uint8Array(64);
        var p = [gf(), gf(), gf(), gf()], q = [gf(), gf(), gf(), gf()];
        if (n < 64) return -1;
        if (unpackneg(q, pk)) return -1;
        for (i = 0; i < n; i++) m[i] = sm[i];
        for (i = 0; i < 32; i++) m[i + 32] = pk[i];
        crypto_hash(h, m, n);
        reduce2(h);
        scalarmult(p, q, h);
        scalarbase(q, sm.subarray(32));
        add2(p, q);
        pack(t, p);
        n -= 64;
        if (crypto_verify_32(sm, 0, t, 0)) {
          for (i = 0; i < n; i++) m[i] = 0;
          return -1;
        }
        for (i = 0; i < n; i++) m[i] = sm[i + 64];
        return n;
      }
      var crypto_secretbox_KEYBYTES = 32, crypto_secretbox_NONCEBYTES = 24, crypto_secretbox_ZEROBYTES = 32, crypto_secretbox_BOXZEROBYTES = 16, crypto_scalarmult_BYTES = 32, crypto_scalarmult_SCALARBYTES = 32, crypto_box_PUBLICKEYBYTES = 32, crypto_box_SECRETKEYBYTES = 32, crypto_box_BEFORENMBYTES = 32, crypto_box_NONCEBYTES = crypto_secretbox_NONCEBYTES, crypto_box_ZEROBYTES = crypto_secretbox_ZEROBYTES, crypto_box_BOXZEROBYTES = crypto_secretbox_BOXZEROBYTES, crypto_sign_BYTES = 64, crypto_sign_PUBLICKEYBYTES = 32, crypto_sign_SECRETKEYBYTES = 64, crypto_sign_SEEDBYTES = 32, crypto_hash_BYTES = 64;
      nacl3.lowlevel = {
        crypto_core_hsalsa20,
        crypto_stream_xor,
        crypto_stream,
        crypto_stream_salsa20_xor,
        crypto_stream_salsa20,
        crypto_onetimeauth,
        crypto_onetimeauth_verify,
        crypto_verify_16,
        crypto_verify_32,
        crypto_secretbox,
        crypto_secretbox_open,
        crypto_scalarmult,
        crypto_scalarmult_base,
        crypto_box_beforenm,
        crypto_box_afternm,
        crypto_box,
        crypto_box_open,
        crypto_box_keypair,
        crypto_hash,
        crypto_sign,
        crypto_sign_keypair,
        crypto_sign_open,
        crypto_secretbox_KEYBYTES,
        crypto_secretbox_NONCEBYTES,
        crypto_secretbox_ZEROBYTES,
        crypto_secretbox_BOXZEROBYTES,
        crypto_scalarmult_BYTES,
        crypto_scalarmult_SCALARBYTES,
        crypto_box_PUBLICKEYBYTES,
        crypto_box_SECRETKEYBYTES,
        crypto_box_BEFORENMBYTES,
        crypto_box_NONCEBYTES,
        crypto_box_ZEROBYTES,
        crypto_box_BOXZEROBYTES,
        crypto_sign_BYTES,
        crypto_sign_PUBLICKEYBYTES,
        crypto_sign_SECRETKEYBYTES,
        crypto_sign_SEEDBYTES,
        crypto_hash_BYTES,
        gf,
        D: D2,
        L,
        pack25519,
        unpack25519,
        M,
        A: A2,
        S: S2,
        Z,
        pow2523,
        add: add2,
        set25519,
        modL,
        scalarmult,
        scalarbase
      };
      function checkLengths(k, n) {
        if (k.length !== crypto_secretbox_KEYBYTES) throw new Error("bad key size");
        if (n.length !== crypto_secretbox_NONCEBYTES) throw new Error("bad nonce size");
      }
      function checkBoxLengths(pk, sk) {
        if (pk.length !== crypto_box_PUBLICKEYBYTES) throw new Error("bad public key size");
        if (sk.length !== crypto_box_SECRETKEYBYTES) throw new Error("bad secret key size");
      }
      function checkArrayTypes() {
        for (var i = 0; i < arguments.length; i++) {
          if (!(arguments[i] instanceof Uint8Array))
            throw new TypeError("unexpected type, use Uint8Array");
        }
      }
      function cleanup(arr) {
        for (var i = 0; i < arr.length; i++) arr[i] = 0;
      }
      nacl3.randomBytes = function(n) {
        var b = new Uint8Array(n);
        randombytes(b, n);
        return b;
      };
      nacl3.secretbox = function(msg, nonce, key) {
        checkArrayTypes(msg, nonce, key);
        checkLengths(key, nonce);
        var m = new Uint8Array(crypto_secretbox_ZEROBYTES + msg.length);
        var c = new Uint8Array(m.length);
        for (var i = 0; i < msg.length; i++) m[i + crypto_secretbox_ZEROBYTES] = msg[i];
        crypto_secretbox(c, m, m.length, nonce, key);
        return c.subarray(crypto_secretbox_BOXZEROBYTES);
      };
      nacl3.secretbox.open = function(box, nonce, key) {
        checkArrayTypes(box, nonce, key);
        checkLengths(key, nonce);
        var c = new Uint8Array(crypto_secretbox_BOXZEROBYTES + box.length);
        var m = new Uint8Array(c.length);
        for (var i = 0; i < box.length; i++) c[i + crypto_secretbox_BOXZEROBYTES] = box[i];
        if (c.length < 32) return null;
        if (crypto_secretbox_open(m, c, c.length, nonce, key) !== 0) return null;
        return m.subarray(crypto_secretbox_ZEROBYTES);
      };
      nacl3.secretbox.keyLength = crypto_secretbox_KEYBYTES;
      nacl3.secretbox.nonceLength = crypto_secretbox_NONCEBYTES;
      nacl3.secretbox.overheadLength = crypto_secretbox_BOXZEROBYTES;
      nacl3.scalarMult = function(n, p) {
        checkArrayTypes(n, p);
        if (n.length !== crypto_scalarmult_SCALARBYTES) throw new Error("bad n size");
        if (p.length !== crypto_scalarmult_BYTES) throw new Error("bad p size");
        var q = new Uint8Array(crypto_scalarmult_BYTES);
        crypto_scalarmult(q, n, p);
        return q;
      };
      nacl3.scalarMult.base = function(n) {
        checkArrayTypes(n);
        if (n.length !== crypto_scalarmult_SCALARBYTES) throw new Error("bad n size");
        var q = new Uint8Array(crypto_scalarmult_BYTES);
        crypto_scalarmult_base(q, n);
        return q;
      };
      nacl3.scalarMult.scalarLength = crypto_scalarmult_SCALARBYTES;
      nacl3.scalarMult.groupElementLength = crypto_scalarmult_BYTES;
      nacl3.box = function(msg, nonce, publicKey2, secretKey) {
        var k = nacl3.box.before(publicKey2, secretKey);
        return nacl3.secretbox(msg, nonce, k);
      };
      nacl3.box.before = function(publicKey2, secretKey) {
        checkArrayTypes(publicKey2, secretKey);
        checkBoxLengths(publicKey2, secretKey);
        var k = new Uint8Array(crypto_box_BEFORENMBYTES);
        crypto_box_beforenm(k, publicKey2, secretKey);
        return k;
      };
      nacl3.box.after = nacl3.secretbox;
      nacl3.box.open = function(msg, nonce, publicKey2, secretKey) {
        var k = nacl3.box.before(publicKey2, secretKey);
        return nacl3.secretbox.open(msg, nonce, k);
      };
      nacl3.box.open.after = nacl3.secretbox.open;
      nacl3.box.keyPair = function() {
        var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
        var sk = new Uint8Array(crypto_box_SECRETKEYBYTES);
        crypto_box_keypair(pk, sk);
        return { publicKey: pk, secretKey: sk };
      };
      nacl3.box.keyPair.fromSecretKey = function(secretKey) {
        checkArrayTypes(secretKey);
        if (secretKey.length !== crypto_box_SECRETKEYBYTES)
          throw new Error("bad secret key size");
        var pk = new Uint8Array(crypto_box_PUBLICKEYBYTES);
        crypto_scalarmult_base(pk, secretKey);
        return { publicKey: pk, secretKey: new Uint8Array(secretKey) };
      };
      nacl3.box.publicKeyLength = crypto_box_PUBLICKEYBYTES;
      nacl3.box.secretKeyLength = crypto_box_SECRETKEYBYTES;
      nacl3.box.sharedKeyLength = crypto_box_BEFORENMBYTES;
      nacl3.box.nonceLength = crypto_box_NONCEBYTES;
      nacl3.box.overheadLength = nacl3.secretbox.overheadLength;
      nacl3.sign = function(msg, secretKey) {
        checkArrayTypes(msg, secretKey);
        if (secretKey.length !== crypto_sign_SECRETKEYBYTES)
          throw new Error("bad secret key size");
        var signedMsg = new Uint8Array(crypto_sign_BYTES + msg.length);
        crypto_sign(signedMsg, msg, msg.length, secretKey);
        return signedMsg;
      };
      nacl3.sign.open = function(signedMsg, publicKey2) {
        checkArrayTypes(signedMsg, publicKey2);
        if (publicKey2.length !== crypto_sign_PUBLICKEYBYTES)
          throw new Error("bad public key size");
        var tmp = new Uint8Array(signedMsg.length);
        var mlen = crypto_sign_open(tmp, signedMsg, signedMsg.length, publicKey2);
        if (mlen < 0) return null;
        var m = new Uint8Array(mlen);
        for (var i = 0; i < m.length; i++) m[i] = tmp[i];
        return m;
      };
      nacl3.sign.detached = function(msg, secretKey) {
        var signedMsg = nacl3.sign(msg, secretKey);
        var sig = new Uint8Array(crypto_sign_BYTES);
        for (var i = 0; i < sig.length; i++) sig[i] = signedMsg[i];
        return sig;
      };
      nacl3.sign.detached.verify = function(msg, sig, publicKey2) {
        checkArrayTypes(msg, sig, publicKey2);
        if (sig.length !== crypto_sign_BYTES)
          throw new Error("bad signature size");
        if (publicKey2.length !== crypto_sign_PUBLICKEYBYTES)
          throw new Error("bad public key size");
        var sm = new Uint8Array(crypto_sign_BYTES + msg.length);
        var m = new Uint8Array(crypto_sign_BYTES + msg.length);
        var i;
        for (i = 0; i < crypto_sign_BYTES; i++) sm[i] = sig[i];
        for (i = 0; i < msg.length; i++) sm[i + crypto_sign_BYTES] = msg[i];
        return crypto_sign_open(m, sm, sm.length, publicKey2) >= 0;
      };
      nacl3.sign.keyPair = function() {
        var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
        var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
        crypto_sign_keypair(pk, sk);
        return { publicKey: pk, secretKey: sk };
      };
      nacl3.sign.keyPair.fromSecretKey = function(secretKey) {
        checkArrayTypes(secretKey);
        if (secretKey.length !== crypto_sign_SECRETKEYBYTES)
          throw new Error("bad secret key size");
        var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
        for (var i = 0; i < pk.length; i++) pk[i] = secretKey[32 + i];
        return { publicKey: pk, secretKey: new Uint8Array(secretKey) };
      };
      nacl3.sign.keyPair.fromSeed = function(seed) {
        checkArrayTypes(seed);
        if (seed.length !== crypto_sign_SEEDBYTES)
          throw new Error("bad seed size");
        var pk = new Uint8Array(crypto_sign_PUBLICKEYBYTES);
        var sk = new Uint8Array(crypto_sign_SECRETKEYBYTES);
        for (var i = 0; i < 32; i++) sk[i] = seed[i];
        crypto_sign_keypair(pk, sk, true);
        return { publicKey: pk, secretKey: sk };
      };
      nacl3.sign.publicKeyLength = crypto_sign_PUBLICKEYBYTES;
      nacl3.sign.secretKeyLength = crypto_sign_SECRETKEYBYTES;
      nacl3.sign.seedLength = crypto_sign_SEEDBYTES;
      nacl3.sign.signatureLength = crypto_sign_BYTES;
      nacl3.hash = function(msg) {
        checkArrayTypes(msg);
        var h = new Uint8Array(crypto_hash_BYTES);
        crypto_hash(h, msg, msg.length);
        return h;
      };
      nacl3.hash.hashLength = crypto_hash_BYTES;
      nacl3.verify = function(x, y) {
        checkArrayTypes(x, y);
        if (x.length === 0 || y.length === 0) return false;
        if (x.length !== y.length) return false;
        return vn(x, 0, y, 0, x.length) === 0 ? true : false;
      };
      nacl3.setPRNG = function(fn) {
        randombytes = fn;
      };
      (function() {
        var crypto2 = typeof self !== "undefined" ? self.crypto || self.msCrypto : null;
        if (crypto2 && crypto2.getRandomValues) {
          var QUOTA = 65536;
          nacl3.setPRNG(function(x, n) {
            var i, v = new Uint8Array(n);
            for (i = 0; i < n; i += QUOTA) {
              crypto2.getRandomValues(v.subarray(i, i + Math.min(n - i, QUOTA)));
            }
            for (i = 0; i < n; i++) x[i] = v[i];
            cleanup(v);
          });
        } else if (typeof __require !== "undefined") {
          crypto2 = __require("crypto");
          if (crypto2 && crypto2.randomBytes) {
            nacl3.setPRNG(function(x, n) {
              var i, v = crypto2.randomBytes(n);
              for (i = 0; i < n; i++) x[i] = v[i];
              cleanup(v);
            });
          }
        }
      })();
    })(typeof module !== "undefined" && module.exports ? module.exports : self.nacl = self.nacl || {});
  }
});

// ../../d258232b77e2/interego-durability/node_modules/tweetnacl-util/nacl-util.js
var require_nacl_util = __commonJS({
  "../../d258232b77e2/interego-durability/node_modules/tweetnacl-util/nacl-util.js"(exports, module) {
    (function(root, f) {
      "use strict";
      if (typeof module !== "undefined" && module.exports) module.exports = f();
      else if (root.nacl) root.nacl.util = f();
      else {
        root.nacl = {};
        root.nacl.util = f();
      }
    })(exports, function() {
      "use strict";
      var util3 = {};
      function validateBase64(s) {
        if (!/^(?:[A-Za-z0-9+\/]{2}[A-Za-z0-9+\/]{2})*(?:[A-Za-z0-9+\/]{2}==|[A-Za-z0-9+\/]{3}=)?$/.test(s)) {
          throw new TypeError("invalid encoding");
        }
      }
      util3.decodeUTF8 = function(s) {
        if (typeof s !== "string") throw new TypeError("expected string");
        var i, d = unescape(encodeURIComponent(s)), b = new Uint8Array(d.length);
        for (i = 0; i < d.length; i++) b[i] = d.charCodeAt(i);
        return b;
      };
      util3.encodeUTF8 = function(arr) {
        var i, s = [];
        for (i = 0; i < arr.length; i++) s.push(String.fromCharCode(arr[i]));
        return decodeURIComponent(escape(s.join("")));
      };
      if (typeof atob === "undefined") {
        if (typeof Buffer.from !== "undefined") {
          util3.encodeBase64 = function(arr) {
            return Buffer.from(arr).toString("base64");
          };
          util3.decodeBase64 = function(s) {
            validateBase64(s);
            return new Uint8Array(Array.prototype.slice.call(Buffer.from(s, "base64"), 0));
          };
        } else {
          util3.encodeBase64 = function(arr) {
            return new Buffer(arr).toString("base64");
          };
          util3.decodeBase64 = function(s) {
            validateBase64(s);
            return new Uint8Array(Array.prototype.slice.call(new Buffer(s, "base64"), 0));
          };
        }
      } else {
        util3.encodeBase64 = function(arr) {
          var i, s = [], len = arr.length;
          for (i = 0; i < len; i++) s.push(String.fromCharCode(arr[i]));
          return btoa(s.join(""));
        };
        util3.decodeBase64 = function(s) {
          validateBase64(s);
          var i, d = atob(s), b = new Uint8Array(d.length);
          for (i = 0; i < d.length; i++) b[i] = d.charCodeAt(i);
          return b;
        };
      }
      return util3;
    });
  }
});

// ../interego-native88/packages/core/src/crypto/encryption.ts
function deriveEncryptionKeyPair(privateKeyHex, principal) {
  const stem = privateKeyHex.toLowerCase().replace(/^0x/, "");
  const seed = principal ? `${stem}:interego-agent-encryption-v1:${principal}` : `${stem}:interego-bridge-encryption-v1`;
  const secretBytes = sha256(utf8ToBytes(seed));
  const kp = import_tweetnacl.default.box.keyPair.fromSecretKey(secretBytes);
  return {
    publicKey: import_tweetnacl_util.default.encodeBase64(kp.publicKey),
    secretKey: import_tweetnacl_util.default.encodeBase64(kp.secretKey),
    algorithm: "X25519-XSalsa20-Poly1305"
  };
}
function generateContentKey() {
  const key = import_tweetnacl.default.randomBytes(32);
  return {
    key: import_tweetnacl_util.default.encodeBase64(key),
    algorithm: "XSalsa20-Poly1305"
  };
}
function encryptContent(plaintext, contentKey) {
  const message = import_tweetnacl_util.default.decodeUTF8(plaintext);
  const key = import_tweetnacl_util.default.decodeBase64(contentKey.key);
  const nonce = import_tweetnacl.default.randomBytes(24);
  const ciphertext = import_tweetnacl.default.secretbox(message, nonce, key);
  if (!ciphertext) throw new Error("Encryption failed");
  return {
    ciphertext: import_tweetnacl_util.default.encodeBase64(ciphertext),
    nonce: import_tweetnacl_util.default.encodeBase64(nonce),
    algorithm: "XSalsa20-Poly1305",
    encryptedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function decryptContent(encrypted, contentKey) {
  const ciphertext = import_tweetnacl_util.default.decodeBase64(encrypted.ciphertext);
  const nonce = import_tweetnacl_util.default.decodeBase64(encrypted.nonce);
  const key = import_tweetnacl_util.default.decodeBase64(contentKey.key);
  const plaintext = import_tweetnacl.default.secretbox.open(ciphertext, nonce, key);
  if (!plaintext) return null;
  return import_tweetnacl_util.default.encodeUTF8(plaintext);
}
function wrapKeyForRecipient(contentKey, recipientPublicKey, senderKeyPair) {
  const message = import_tweetnacl_util.default.decodeBase64(contentKey.key);
  const recipientPub = import_tweetnacl_util.default.decodeBase64(recipientPublicKey);
  const senderSecret = import_tweetnacl_util.default.decodeBase64(senderKeyPair.secretKey);
  const nonce = import_tweetnacl.default.randomBytes(24);
  const wrapped = import_tweetnacl.default.box(message, nonce, recipientPub, senderSecret);
  if (!wrapped) throw new Error("Key wrapping failed");
  return {
    recipientPublicKey,
    wrappedKey: import_tweetnacl_util.default.encodeBase64(wrapped),
    nonce: import_tweetnacl_util.default.encodeBase64(nonce),
    senderPublicKey: senderKeyPair.publicKey
  };
}
function unwrapKey(wrapped, recipientSecretKey) {
  const ciphertext = import_tweetnacl_util.default.decodeBase64(wrapped.wrappedKey);
  const nonce = import_tweetnacl_util.default.decodeBase64(wrapped.nonce);
  const senderPub = import_tweetnacl_util.default.decodeBase64(wrapped.senderPublicKey);
  const recipientSecret = import_tweetnacl_util.default.decodeBase64(recipientSecretKey);
  const keyBytes = import_tweetnacl.default.box.open(ciphertext, nonce, senderPub, recipientSecret);
  if (!keyBytes) return null;
  return {
    key: import_tweetnacl_util.default.encodeBase64(keyBytes),
    algorithm: "XSalsa20-Poly1305"
  };
}
function createEncryptedEnvelope(plaintext, recipientPublicKeys, senderKeyPair) {
  const contentKey = generateContentKey();
  const content = encryptContent(plaintext, contentKey);
  const wrappedKeys = recipientPublicKeys.map(
    (pubKey) => wrapKeyForRecipient(contentKey, pubKey, senderKeyPair)
  );
  return {
    content,
    wrappedKeys,
    algorithm: "X25519-XSalsa20-Poly1305",
    version: 1
  };
}
function openEncryptedEnvelope(envelope, recipientKeyPair) {
  const myWrappedKey = envelope.wrappedKeys.find(
    (wk) => wk.recipientPublicKey === recipientKeyPair.publicKey
  );
  if (!myWrappedKey) return null;
  const contentKey = unwrapKey(myWrappedKey, recipientKeyPair.secretKey);
  if (!contentKey) return null;
  return decryptContent(envelope.content, contentKey);
}
var import_tweetnacl, import_tweetnacl_util;
var init_encryption = __esm({
  "../interego-native88/packages/core/src/crypto/encryption.ts"() {
    "use strict";
    import_tweetnacl = __toESM(require_nacl_fast(), 1);
    import_tweetnacl_util = __toESM(require_nacl_util(), 1);
    init_sha2();
    init_utils();
  }
});

// ../interego-native88/packages/core/src/crypto/facet-encryption.ts
var init_facet_encryption = __esm({
  "../interego-native88/packages/core/src/crypto/facet-encryption.ts"() {
    "use strict";
    init_encryption();
  }
});

// ../../d258232b77e2/interego-durability/node_modules/@noble/curves/abstract/edwards.js
function isEdValidXY(Fp2, CURVE, x, y) {
  const x2 = Fp2.sqr(x);
  const y2 = Fp2.sqr(y);
  const left = Fp2.add(Fp2.mul(CURVE.a, x2), y2);
  const right = Fp2.add(Fp2.ONE, Fp2.mul(CURVE.d, Fp2.mul(x2, y2)));
  return Fp2.eql(left, right);
}
function edwards(params, extraOpts = {}) {
  const opts = extraOpts;
  const validated = createCurveFields("edwards", params, opts, opts.FpFnLE);
  const { Fp: Fp2, Fn: Fn2 } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor } = CURVE;
  validateObject(opts, {}, { uvRatio: "function" });
  const MASK = _2n2 << BigInt(Fn2.BYTES * 8) - _1n4;
  const modP = (n) => Fp2.create(n);
  const uvRatio2 = opts.uvRatio === void 0 ? (u, v) => {
    try {
      return { isValid: true, value: Fp2.sqrt(Fp2.div(u, v)) };
    } catch (e) {
      return { isValid: false, value: _0n4 };
    }
  } : opts.uvRatio;
  if (!isEdValidXY(Fp2, CURVE, CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  function acoord(title, n, banZero = false) {
    const min = banZero ? _1n4 : _0n4;
    aInRange("coordinate " + title, n, min, MASK);
    return n;
  }
  function aedpoint(other) {
    if (!(other instanceof Point))
      throw new Error("EdwardsPoint expected");
  }
  class Point {
    // base / generator point
    static BASE = new Point(CURVE.Gx, CURVE.Gy, _1n4, modP(CURVE.Gx * CURVE.Gy));
    // zero / infinity / identity point
    static ZERO = new Point(_0n4, _1n4, _1n4, _0n4);
    // 0, 1, 1, 0
    // math field
    static Fp = Fp2;
    // scalar field
    static Fn = Fn2;
    X;
    Y;
    Z;
    T;
    constructor(X, Y, Z, T) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y);
      this.Z = acoord("z", Z, true);
      this.T = acoord("t", T);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    /**
     * Create one extended Edwards point from affine coordinates.
     * Does NOT validate that the point is on-curve or torsion-free.
     * Use `.assertValidity()` on adversarial inputs.
     */
    static fromAffine(p) {
      if (p instanceof Point)
        throw new Error("extended point not allowed");
      const { x, y } = p || {};
      acoord("x", x);
      acoord("y", y);
      return new Point(x, y, _1n4, modP(x * y));
    }
    // Uses algo from RFC8032 5.1.3.
    static fromBytes(bytes, zip215 = false) {
      const len = Fp2.BYTES;
      const { a, d } = CURVE;
      bytes = copyBytes(abytes2(bytes, len, "point"));
      abool(zip215, "zip215");
      const normed = copyBytes(bytes);
      const lastByte = bytes[len - 1];
      normed[len - 1] = lastByte & ~128;
      const y = bytesToNumberLE(normed);
      const max = zip215 ? MASK : Fp2.ORDER;
      aInRange("point.y", y, _0n4, max);
      const y2 = modP(y * y);
      const u = modP(y2 - _1n4);
      const v = modP(d * y2 - a);
      let { isValid, value: x } = uvRatio2(u, v);
      if (!isValid)
        throw new Error("bad point: invalid y coordinate");
      const isXOdd = (x & _1n4) === _1n4;
      const isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && x === _0n4 && isLastByteOdd)
        throw new Error("bad point: x=0 and x_0=1");
      if (isLastByteOdd !== isXOdd)
        x = modP(-x);
      return Point.fromAffine({ x, y });
    }
    static fromHex(hex, zip215 = false) {
      return Point.fromBytes(hexToBytes2(hex), zip215);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 8, isLazy = true) {
      wnaf.createCache(this, windowSize);
      if (!isLazy)
        this.multiply(_2n2);
      return this;
    }
    // Useful in fromAffine() - not for fromBytes(), which always created valid points.
    assertValidity() {
      const p = this;
      const { a, d } = CURVE;
      if (p.is0())
        throw new Error("bad point: ZERO");
      const { X, Y, Z, T } = p;
      const X2 = modP(X * X);
      const Y2 = modP(Y * Y);
      const Z2 = modP(Z * Z);
      const Z4 = modP(Z2 * Z2);
      const aX2 = modP(X2 * a);
      const left = modP(Z2 * modP(aX2 + Y2));
      const right = modP(Z4 + modP(d * modP(X2 * Y2)));
      if (left !== right)
        throw new Error("bad point: equation left != right (1)");
      const XY = modP(X * Y);
      const ZT = modP(Z * T);
      if (XY !== ZT)
        throw new Error("bad point: equation left != right (2)");
    }
    // Compare one point to another.
    equals(other) {
      aedpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const X1Z2 = modP(X1 * Z2);
      const X2Z1 = modP(X2 * Z1);
      const Y1Z2 = modP(Y1 * Z2);
      const Y2Z1 = modP(Y2 * Z1);
      return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    negate() {
      return new Point(modP(-this.X), this.Y, this.Z, modP(-this.T));
    }
    // Fast algo for doubling Extended Point.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#doubling-dbl-2008-hwcd
    // Cost: 4M + 4S + 1*a + 6add + 1*2.
    double() {
      const { a } = CURVE;
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const A2 = modP(X1 * X1);
      const B = modP(Y1 * Y1);
      const C = modP(_2n2 * modP(Z1 * Z1));
      const D2 = modP(a * A2);
      const x1y1 = X1 + Y1;
      const E = modP(modP(x1y1 * x1y1) - A2 - B);
      const G4 = D2 + B;
      const F = G4 - C;
      const H3 = D2 - B;
      const X3 = modP(E * F);
      const Y3 = modP(G4 * H3);
      const T3 = modP(E * H3);
      const Z3 = modP(F * G4);
      return new Point(X3, Y3, Z3, T3);
    }
    // Fast algo for adding 2 Extended Points.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#addition-add-2008-hwcd
    // Cost: 9M + 1*a + 1*d + 7add.
    add(other) {
      aedpoint(other);
      const { a, d } = CURVE;
      const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
      const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
      const A2 = modP(X1 * X2);
      const B = modP(Y1 * Y2);
      const C = modP(T1 * d * T2);
      const D2 = modP(Z1 * Z2);
      const E = modP((X1 + Y1) * (X2 + Y2) - A2 - B);
      const F = D2 - C;
      const G4 = D2 + C;
      const H3 = modP(B - a * A2);
      const X3 = modP(E * F);
      const Y3 = modP(G4 * H3);
      const T3 = modP(E * H3);
      const Z3 = modP(F * G4);
      return new Point(X3, Y3, Z3, T3);
    }
    subtract(other) {
      aedpoint(other);
      return this.add(other.negate());
    }
    // Constant-time multiplication.
    multiply(scalar) {
      if (!Fn2.isValidNot0(scalar))
        throw new RangeError("invalid scalar: expected 1 <= sc < curve.n");
      const { p, f } = wnaf.cached(this, scalar, (p2) => normalizeZ(Point, p2));
      return normalizeZ(Point, [p, f])[0];
    }
    // Non-constant-time multiplication. Uses double-and-add algorithm.
    // It's faster, but should only be used when you don't care about
    // an exposed private key e.g. sig verification.
    // Keeps the same subgroup-scalar contract: 0 is allowed for public-scalar callers, but
    // n and larger values are rejected instead of being reduced mod n to the identity point.
    multiplyUnsafe(scalar) {
      if (!Fn2.isValid(scalar))
        throw new RangeError("invalid scalar: expected 0 <= sc < curve.n");
      if (scalar === _0n4)
        return Point.ZERO;
      if (this.is0() || scalar === _1n4)
        return this;
      return wnaf.unsafe(this, scalar, (p) => normalizeZ(Point, p));
    }
    // Checks if point is of small order.
    // If you add something to small order point, you will have "dirty"
    // point with torsion component.
    // Clears cofactor and checks if the result is 0.
    isSmallOrder() {
      return this.clearCofactor().is0();
    }
    // Multiplies point by curve order and checks if the result is 0.
    // Returns `false` is the point is dirty.
    isTorsionFree() {
      return wnaf.unsafe(this, CURVE.n).is0();
    }
    // Converts Extended point to default (x, y) coordinates.
    // Can accept precomputed Z^-1 - for example, from invertBatch.
    toAffine(invertedZ) {
      const p = this;
      let iz = invertedZ;
      const { X, Y, Z } = p;
      const is0 = p.is0();
      if (iz == null)
        iz = is0 ? _8n2 : Fp2.inv(Z);
      const x = modP(X * iz);
      const y = modP(Y * iz);
      const zz = Fp2.mul(Z, iz);
      if (is0)
        return { x: _0n4, y: _1n4 };
      if (zz !== _1n4)
        throw new Error("invZ was invalid");
      return { x, y };
    }
    clearCofactor() {
      if (cofactor === _1n4)
        return this;
      return this.multiplyUnsafe(cofactor);
    }
    toBytes() {
      const { x, y } = this.toAffine();
      const bytes = Fp2.toBytes(y);
      bytes[bytes.length - 1] |= x & _1n4 ? 128 : 0;
      return bytes;
    }
    toHex() {
      return bytesToHex2(this.toBytes());
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  const wnaf = new wNAF(Point, Fn2.BITS);
  if (Fn2.BITS >= 8)
    Point.BASE.precompute(8);
  Object.freeze(Point.prototype);
  Object.freeze(Point);
  return Point;
}
var _0n4, _1n4, _2n2, _8n2, PrimeEdwardsPoint;
var init_edwards = __esm({
  "../../d258232b77e2/interego-durability/node_modules/@noble/curves/abstract/edwards.js"() {
    init_utils2();
    init_curve();
    _0n4 = /* @__PURE__ */ BigInt(0);
    _1n4 = /* @__PURE__ */ BigInt(1);
    _2n2 = /* @__PURE__ */ BigInt(2);
    _8n2 = /* @__PURE__ */ BigInt(8);
    PrimeEdwardsPoint = class {
      static BASE;
      static ZERO;
      static Fp;
      static Fn;
      ep;
      /**
       * Wrap one internal Edwards representative directly.
       * This is not a canonical encoding boundary: alternate Edwards
       * representatives may still describe the same abstract wrapper element.
       */
      constructor(ep) {
        this.ep = ep;
      }
      // Static methods that must be implemented by subclasses
      static fromBytes(_bytes) {
        notImplemented();
      }
      static fromHex(_hex) {
        notImplemented();
      }
      get x() {
        return this.toAffine().x;
      }
      get y() {
        return this.toAffine().y;
      }
      // Common implementations
      clearCofactor() {
        return this;
      }
      assertValidity() {
        this.ep.assertValidity();
      }
      /**
       * Return affine coordinates of the current internal Edwards representative.
       * This is a convenience helper, not a canonical Ristretto/Decaf encoding.
       * Equal abstract elements may expose different `x` / `y`; use
       * `toBytes()` / `fromBytes()` for canonical roundtrips.
       */
      toAffine(invertedZ) {
        return this.ep.toAffine(invertedZ);
      }
      toHex() {
        return bytesToHex2(this.toBytes());
      }
      toString() {
        return this.toHex();
      }
      isTorsionFree() {
        return true;
      }
      isSmallOrder() {
        return false;
      }
      add(other) {
        this.assertSame(other);
        return this.init(this.ep.add(other.ep));
      }
      subtract(other) {
        this.assertSame(other);
        return this.init(this.ep.subtract(other.ep));
      }
      multiply(scalar) {
        return this.init(this.ep.multiply(scalar));
      }
      multiplyUnsafe(scalar) {
        return this.init(this.ep.multiplyUnsafe(scalar));
      }
      double() {
        return this.init(this.ep.double());
      }
      negate() {
        return this.init(this.ep.negate());
      }
      precompute(windowSize, isLazy) {
        this.ep.precompute(windowSize, isLazy);
        return this;
      }
    };
  }
});

// ../../d258232b77e2/interego-durability/node_modules/@noble/curves/ed25519.js
function ed25519_pow_2_252_3(x) {
  const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
  const P = ed25519_CURVE_p;
  const x2 = x * x % P;
  const b2 = x2 * x % P;
  const b4 = pow2(b2, _2n3, P) * b2 % P;
  const b5 = pow2(b4, _1n5, P) * x % P;
  const b10 = pow2(b5, _5n2, P) * b5 % P;
  const b20 = pow2(b10, _10n, P) * b10 % P;
  const b40 = pow2(b20, _20n, P) * b20 % P;
  const b80 = pow2(b40, _40n, P) * b40 % P;
  const b160 = pow2(b80, _80n, P) * b80 % P;
  const b240 = pow2(b160, _80n, P) * b80 % P;
  const b250 = pow2(b240, _10n, P) * b10 % P;
  const pow_p_5_8 = pow2(b250, _2n3, P) * x % P;
  return { pow_p_5_8, b2 };
}
function uvRatio(u, v) {
  const P = ed25519_CURVE_p;
  const v3 = mod(v * v * v, P);
  const v7 = mod(v3 * v3 * v, P);
  const pow = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod(u * v3 * pow, P);
  const vx2 = mod(v * x * x, P);
  const root1 = x;
  const root2 = mod(x * ED25519_SQRT_M1, P);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u, P);
  const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if (isNegativeLE(x, P))
    x = mod(-x, P);
  return { isValid: useRoot1 || useRoot2, value: x };
}
function calcElligatorRistrettoMap(r0) {
  const { d } = ed25519_CURVE;
  const P = ed25519_CURVE_p;
  const mod2 = (n) => Fp.create(n);
  const r = mod2(SQRT_M1 * r0 * r0);
  const Ns = mod2((r + _1n5) * ONE_MINUS_D_SQ);
  let c = BigInt(-1);
  const D2 = mod2((c - d * r) * mod2(r + d));
  let { isValid: Ns_D_is_sq, value: s } = uvRatio(Ns, D2);
  let s_ = mod2(s * r0);
  if (!isNegativeLE(s_, P))
    s_ = mod2(-s_);
  if (!Ns_D_is_sq)
    s = s_;
  if (!Ns_D_is_sq)
    c = r;
  const Nt = mod2(c * (r - _1n5) * D_MINUS_ONE_SQ - D2);
  const s2 = s * s;
  const W0 = mod2((s + s) * D2);
  const W1 = mod2(Nt * SQRT_AD_MINUS_ONE);
  const W2 = mod2(_1n5 - s2);
  const W3 = mod2(_1n5 + s2);
  return new ed25519_Point(mod2(W0 * W3), mod2(W2 * W1), mod2(W1 * W3), mod2(W0 * W2));
}
var _0n5, _1n5, _2n3, _5n2, _8n3, ed25519_CURVE_p, ed25519_CURVE, ED25519_SQRT_M1, ed25519_Point, Fp, Fn, SQRT_M1, SQRT_AD_MINUS_ONE, INVSQRT_A_MINUS_D, ONE_MINUS_D_SQ, D_MINUS_ONE_SQ, invertSqrt, MAX_255B, bytes255ToNumberLE, _RistrettoPoint, ristretto255, ristretto255_hasher;
var init_ed25519 = __esm({
  "../../d258232b77e2/interego-durability/node_modules/@noble/curves/ed25519.js"() {
    init_sha2();
    init_utils();
    init_edwards();
    init_hash_to_curve();
    init_modular();
    init_utils2();
    _0n5 = /* @__PURE__ */ BigInt(0);
    _1n5 = /* @__PURE__ */ BigInt(1);
    _2n3 = /* @__PURE__ */ BigInt(2);
    _5n2 = /* @__PURE__ */ BigInt(5);
    _8n3 = /* @__PURE__ */ BigInt(8);
    ed25519_CURVE_p = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
    ed25519_CURVE = /* @__PURE__ */ (() => ({
      p: ed25519_CURVE_p,
      n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
      h: _8n3,
      a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
      d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
      Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
      Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
    }))();
    ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
    ed25519_Point = /* @__PURE__ */ edwards(ed25519_CURVE, { uvRatio });
    Fp = /* @__PURE__ */ (() => ed25519_Point.Fp)();
    Fn = /* @__PURE__ */ (() => ed25519_Point.Fn)();
    SQRT_M1 = ED25519_SQRT_M1;
    SQRT_AD_MINUS_ONE = /* @__PURE__ */ BigInt("25063068953384623474111414158702152701244531502492656460079210482610430750235");
    INVSQRT_A_MINUS_D = /* @__PURE__ */ BigInt("54469307008909316920995813868745141605393597292927456921205312896311721017578");
    ONE_MINUS_D_SQ = /* @__PURE__ */ BigInt("1159843021668779879193775521855586647937357759715417654439879720876111806838");
    D_MINUS_ONE_SQ = /* @__PURE__ */ BigInt("40440834346308536858101042469323190826248399146238708352240133220865137265952");
    invertSqrt = (number) => uvRatio(_1n5, number);
    MAX_255B = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
    bytes255ToNumberLE = (bytes) => Fp.create(bytesToNumberLE(bytes) & MAX_255B);
    _RistrettoPoint = class __RistrettoPoint extends PrimeEdwardsPoint {
      // Do NOT change syntax: the following gymnastics is done,
      // because typescript strips comments, which makes bundlers disable tree-shaking.
      // prettier-ignore
      static BASE = /* @__PURE__ */ (() => new __RistrettoPoint(ed25519_Point.BASE))();
      // prettier-ignore
      static ZERO = /* @__PURE__ */ (() => new __RistrettoPoint(ed25519_Point.ZERO))();
      // prettier-ignore
      static Fp = /* @__PURE__ */ (() => Fp)();
      // prettier-ignore
      static Fn = /* @__PURE__ */ (() => Fn)();
      constructor(ep) {
        super(ep);
      }
      /**
       * Create one Ristretto255 point from affine Edwards coordinates.
       * This wraps the internal Edwards representative directly and is not a
       * canonical ristretto255 decoding path.
       * Use `toBytes()` / `fromBytes()` if canonical ristretto255 bytes matter.
       */
      static fromAffine(ap) {
        return new __RistrettoPoint(ed25519_Point.fromAffine(ap));
      }
      assertSame(other) {
        if (!(other instanceof __RistrettoPoint))
          throw new Error("RistrettoPoint expected");
      }
      init(ep) {
        return new __RistrettoPoint(ep);
      }
      static fromBytes(bytes) {
        abytes(bytes, 32);
        const { a, d } = ed25519_CURVE;
        const P = ed25519_CURVE_p;
        const mod2 = (n) => Fp.create(n);
        const s = bytes255ToNumberLE(bytes);
        if (!equalBytes(Fp.toBytes(s), bytes) || isNegativeLE(s, P))
          throw new Error("invalid ristretto255 encoding 1");
        const s2 = mod2(s * s);
        const u1 = mod2(_1n5 + a * s2);
        const u2 = mod2(_1n5 - a * s2);
        const u1_2 = mod2(u1 * u1);
        const u2_2 = mod2(u2 * u2);
        const v = mod2(a * d * u1_2 - u2_2);
        const { isValid, value: I } = invertSqrt(mod2(v * u2_2));
        const Dx = mod2(I * u2);
        const Dy = mod2(I * Dx * v);
        let x = mod2((s + s) * Dx);
        if (isNegativeLE(x, P))
          x = mod2(-x);
        const y = mod2(u1 * Dy);
        const t = mod2(x * y);
        if (!isValid || isNegativeLE(t, P) || y === _0n5)
          throw new Error("invalid ristretto255 encoding 2");
        return new __RistrettoPoint(new ed25519_Point(x, y, _1n5, t));
      }
      /**
       * Converts ristretto-encoded string to ristretto point.
       * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-decode).
       * @param hex - Ristretto-encoded 32 bytes. Not every 32-byte string is valid ristretto encoding
       */
      static fromHex(hex) {
        return __RistrettoPoint.fromBytes(hexToBytes(hex));
      }
      /**
       * Encodes ristretto point to Uint8Array.
       * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-encode).
       */
      toBytes() {
        let { X, Y, Z, T } = this.ep;
        const P = ed25519_CURVE_p;
        const mod2 = (n) => Fp.create(n);
        const u1 = mod2(mod2(Z + Y) * mod2(Z - Y));
        const u2 = mod2(X * Y);
        const u2sq = mod2(u2 * u2);
        const { value: invsqrt } = invertSqrt(mod2(u1 * u2sq));
        const D1 = mod2(invsqrt * u1);
        const D2 = mod2(invsqrt * u2);
        const zInv = mod2(D1 * D2 * T);
        let D3;
        if (isNegativeLE(T * zInv, P)) {
          let _x = mod2(Y * SQRT_M1);
          let _y = mod2(X * SQRT_M1);
          X = _x;
          Y = _y;
          D3 = mod2(D1 * INVSQRT_A_MINUS_D);
        } else {
          D3 = D2;
        }
        if (isNegativeLE(X * zInv, P))
          Y = mod2(-Y);
        let s = mod2((Z - Y) * D3);
        if (isNegativeLE(s, P))
          s = mod2(-s);
        return Fp.toBytes(s);
      }
      /**
       * Compares two Ristretto points.
       * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-equals).
       */
      equals(other) {
        this.assertSame(other);
        const { X: X1, Y: Y1 } = this.ep;
        const { X: X2, Y: Y2 } = other.ep;
        const mod2 = (n) => Fp.create(n);
        const one = mod2(X1 * Y2) === mod2(Y1 * X2);
        const two = mod2(Y1 * Y2) === mod2(X1 * X2);
        return one || two;
      }
      is0() {
        return this.equals(__RistrettoPoint.ZERO);
      }
    };
    Object.freeze(_RistrettoPoint.BASE);
    Object.freeze(_RistrettoPoint.ZERO);
    Object.freeze(_RistrettoPoint.prototype);
    Object.freeze(_RistrettoPoint);
    ristretto255 = /* @__PURE__ */ Object.freeze({ Point: _RistrettoPoint });
    ristretto255_hasher = Object.freeze({
      Point: _RistrettoPoint,
      /**
      * Spec: https://www.rfc-editor.org/rfc/rfc9380.html#name-hashing-to-ristretto255. Caveats:
      * * There are no test vectors
      * * encodeToCurve / mapToCurve is undefined
      * * mapToCurve would be `calcElligatorRistrettoMap(scalars[0])`, not ristretto255_map!
      * * hashToScalar is undefined too, so we just use OPRF implementation
      * * We cannot re-use 'createHasher', because ristretto255_map is different algorithm/RFC
        (os2ip -> bytes255ToNumberLE)
      * * mapToCurve == calcElligatorRistrettoMap, hashToCurve == ristretto255_map
      * * hashToScalar is undefined in RFC9380 for ristretto, so we use the OPRF
        version here. Using `bytes255ToNumblerLE` will create a different result
        if we use `bytes255ToNumberLE` as os2ip
      * * current version is closest to spec.
      */
      hashToCurve(msg, options) {
        const DST = options?.DST === void 0 ? "ristretto255_XMD:SHA-512_R255MAP_RO_" : options.DST;
        const xmd = expand_message_xmd(msg, DST, 64, sha512);
        return ristretto255_hasher.deriveToCurve(xmd);
      },
      hashToScalar(msg, options = { DST: _DST_scalar }) {
        const xmd = expand_message_xmd(msg, options.DST, 64, sha512);
        return Fn.create(bytesToNumberLE(xmd));
      },
      /**
       * HashToCurve-like construction based on RFC 9496 (Element Derivation).
       * Converts 64 uniform random bytes into a curve point.
       *
       * WARNING: This represents an older hash-to-curve construction from before
       * RFC 9380 was finalized.
       * It was later reused as a component in the newer
       * `hash_to_ristretto255` function defined in RFC 9380.
       */
      deriveToCurve(bytes) {
        abytes(bytes, 64);
        const r1 = bytes255ToNumberLE(bytes.subarray(0, 32));
        const R1 = calcElligatorRistrettoMap(r1);
        const r2 = bytes255ToNumberLE(bytes.subarray(32, 64));
        const R2 = calcElligatorRistrettoMap(r2);
        return new _RistrettoPoint(R1.add(R2));
      }
    });
  }
});

// ../interego-native88/packages/core/src/crypto/pedersen.ts
var G, H_DOMAIN, H;
var init_pedersen = __esm({
  "../interego-native88/packages/core/src/crypto/pedersen.ts"() {
    "use strict";
    init_ed25519();
    init_ipfs();
    G = ristretto255.Point.BASE;
    H_DOMAIN = new TextEncoder().encode("interego/v1/pedersen/H-generator");
    H = ristretto255_hasher.hashToCurve(H_DOMAIN);
  }
});

// ../interego-native88/packages/core/src/crypto/shamir.ts
var init_shamir = __esm({
  "../interego-native88/packages/core/src/crypto/shamir.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/crypto/feldman-vss.ts
var G2;
var init_feldman_vss = __esm({
  "../interego-native88/packages/core/src/crypto/feldman-vss.ts"() {
    "use strict";
    init_ed25519();
    G2 = ristretto255.Point.BASE;
  }
});

// ../interego-native88/packages/core/src/crypto/dkg.ts
var init_dkg = __esm({
  "../interego-native88/packages/core/src/crypto/dkg.ts"() {
    "use strict";
    init_feldman_vss();
  }
});

// ../interego-native88/packages/core/src/crypto/dp-accountant.ts
var init_dp_accountant = __esm({
  "../interego-native88/packages/core/src/crypto/dp-accountant.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/crypto/range-proof.ts
var G3, H_DOMAIN2, H2;
var init_range_proof = __esm({
  "../interego-native88/packages/core/src/crypto/range-proof.ts"() {
    "use strict";
    init_ed25519();
    init_ipfs();
    G3 = ristretto255.Point.BASE;
    H_DOMAIN2 = new TextEncoder().encode("interego/v1/pedersen/H-generator");
    H2 = ristretto255_hasher.hashToCurve(H_DOMAIN2);
  }
});

// ../interego-native88/packages/core/src/crypto/zk/proofs.ts
var import_tweetnacl2, import_tweetnacl_util2;
var init_proofs = __esm({
  "../interego-native88/packages/core/src/crypto/zk/proofs.ts"() {
    "use strict";
    import_tweetnacl2 = __toESM(require_nacl_fast(), 1);
    import_tweetnacl_util2 = __toESM(require_nacl_util(), 1);
    init_ipfs();
    init_types();
  }
});

// ../interego-native88/packages/core/src/crypto/zk/index.ts
var init_zk = __esm({
  "../interego-native88/packages/core/src/crypto/zk/index.ts"() {
    "use strict";
    init_proofs();
  }
});

// ../interego-native88/packages/core/src/crypto/index.ts
var init_crypto = __esm({
  "../interego-native88/packages/core/src/crypto/index.ts"() {
    "use strict";
    init_types2();
    init_ipfs();
    init_wallet();
    init_schnorr();
    init_wallet();
    init_encryption();
    init_facet_encryption();
    init_pedersen();
    init_shamir();
    init_dkg();
    init_dp_accountant();
    init_feldman_vss();
    init_range_proof();
    init_zk();
  }
});

// ../interego-native88/packages/core/src/lattice/node-id.ts
function mintNodeId(kind, hash) {
  return `${PGSL_ID_AUTHORITY}/${kind}/${hash}`;
}
function isPgslNodeId(x) {
  return typeof x === "string" && (x.startsWith(`${PGSL_ID_AUTHORITY}/`) || x.startsWith(LEGACY_PGSL_PREFIX));
}
var PGSL_ID_AUTHORITY, LEGACY_PGSL_PREFIX;
var init_node_id = __esm({
  "../interego-native88/packages/core/src/lattice/node-id.ts"() {
    "use strict";
    PGSL_ID_AUTHORITY = "https://relay.interego.xwisee.com/ns/pgsl";
    LEGACY_PGSL_PREFIX = "urn:pgsl:";
  }
});

// ../interego-native88/packages/core/src/lattice/adapter.ts
import { createHash } from "node:crypto";
function sha256Hex2(input) {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}
function fallbackAtomUri(value2) {
  const hash = sha256Hex2(`atom:${String(value2)}`);
  return mintNodeId("atom", hash.slice(0, 40));
}
function fallbackFragmentUri(items, level) {
  const hash = sha256Hex2(`fragment:L${level}:${items.join("|")}`);
  return mintNodeId("fragment", hash.slice(0, 40));
}
function fallbackItemToUri(item) {
  if (typeof item === "string" && /^[a-z][a-z0-9+.-]*:/i.test(item)) {
    return item;
  }
  return fallbackAtomUri(item);
}
function fallbackLatticeAdapter() {
  return {
    mint(content) {
      const iri2 = fallbackAtomUri(content);
      return {
        iri: iri2,
        level: 0,
        contentHash: sha256Hex2(`atom:${String(content)}`)
      };
    },
    promote(items) {
      if (items.length === 0) {
        throw new TypeError("promote() requires at least one item");
      }
      const uris = items.map(fallbackItemToUri);
      const level = Math.max(0, items.length - 1);
      const apex = level === 0 ? uris[0] : fallbackFragmentUri(uris, level);
      return { apex, level };
    },
    decompose(_fragmentIri) {
      return null;
    }
  };
}
function setKernelLatticeAdapter(adapter) {
  _activeAdapter = adapter ?? fallbackLatticeAdapter();
}
var _activeAdapter;
var init_adapter = __esm({
  "../interego-native88/packages/core/src/lattice/adapter.ts"() {
    "use strict";
    init_node_id();
    _activeAdapter = fallbackLatticeAdapter();
  }
});

// ../interego-native88/packages/core/src/kernel/affordance-extraction.ts
var SHACL4, SH_PROPERTY3, SH_PATH3, SH_DATATYPE2, SH_MIN_COUNT2, SH_MAX_COUNT2, SH_MIN_LENGTH2, SH_MAX_LENGTH2, SH_PATTERN2, SH_NAME, SH_DESCRIPTION, AFFORDANCE_TYPE_IRIS2, CG_ACTION2, HYDRA_TARGET2, HYDRA_METHOD2, DCAT_MEDIA_TYPE2, HYDRA_EXPECTS, HYDRA_RETURNS, CG_INPUT_SHAPE, DCAT_ACCESS_SERVICE, DCAT_ACCESS_URL, CG_READS, CG_STORE, CG_POPULATED_BY, CG_ADMITS, CG_ENROLMENT_REGISTER, RDFS_LABEL;
var init_affordance_extraction = __esm({
  "../interego-native88/packages/core/src/kernel/affordance-extraction.ts"() {
    "use strict";
    init_turtle_parser();
    init_namespaces();
    SHACL4 = "http://www.w3.org/ns/shacl#";
    SH_PROPERTY3 = `${SHACL4}property`;
    SH_PATH3 = `${SHACL4}path`;
    SH_DATATYPE2 = `${SHACL4}datatype`;
    SH_MIN_COUNT2 = `${SHACL4}minCount`;
    SH_MAX_COUNT2 = `${SHACL4}maxCount`;
    SH_MIN_LENGTH2 = `${SHACL4}minLength`;
    SH_MAX_LENGTH2 = `${SHACL4}maxLength`;
    SH_PATTERN2 = `${SHACL4}pattern`;
    SH_NAME = `${SHACL4}name`;
    SH_DESCRIPTION = `${SHACL4}description`;
    AFFORDANCE_TYPE_IRIS2 = [
      `${CG}Affordance`,
      // Harness namespace mirror — see applications/_shared/affordance-mcp/index.ts.
      `${IEH}Affordance`,
      // Deprecated read-alias: data persisted while the kernel emitted the
      // never-published ns/cgh# IRI still carries this type in its (signed) bytes.
      `${CGH_LEGACY}Affordance`,
      `${HYDRA}Operation`
    ];
    CG_ACTION2 = `${CG}action`;
    HYDRA_TARGET2 = `${HYDRA}target`;
    HYDRA_METHOD2 = `${HYDRA}method`;
    DCAT_MEDIA_TYPE2 = `${DCAT}mediaType`;
    HYDRA_EXPECTS = `${HYDRA}expects`;
    HYDRA_RETURNS = `${HYDRA}returns`;
    CG_INPUT_SHAPE = `${CG}inputShape`;
    DCAT_ACCESS_SERVICE = `${DCAT}accessService`;
    DCAT_ACCESS_URL = `${DCAT}accessURL`;
    CG_READS = `${CG}reads`;
    CG_STORE = `${CG}store`;
    CG_POPULATED_BY = `${CG}populatedBy`;
    CG_ADMITS = `${CG}admits`;
    CG_ENROLMENT_REGISTER = `${CG}enrolmentRegister`;
    RDFS_LABEL = `${RDFS}label`;
  }
});

// ../interego-native88/packages/core/src/kernel/types.ts
var init_types3 = __esm({
  "../interego-native88/packages/core/src/kernel/types.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/kernel/hypermedia-markdown.ts
var HMD_PROFILE_IRI, HMD_NS, HMD_PROFILE_LINK_HEADER, HMD_PROJECTION_CONTEXT;
var init_hypermedia_markdown = __esm({
  "../interego-native88/packages/core/src/kernel/hypermedia-markdown.ts"() {
    "use strict";
    init_hypermedia();
    HMD_PROFILE_IRI = "https://relay.interego.xwisee.com/ns/maintainer/hmd";
    HMD_NS = `${HMD_PROFILE_IRI}#`;
    HMD_PROFILE_LINK_HEADER = `<${HMD_PROFILE_IRI}>; rel="profile"`;
    HMD_PROJECTION_CONTEXT = Object.freeze({
      hmd: HMD_NS,
      owl: "http://www.w3.org/2002/07/owl#",
      skos: "http://www.w3.org/2004/02/skos/core#",
      schema: "https://schema.org/",
      wdrs: "http://www.w3.org/2007/05/powder-s#",
      // `type:` inside :::control blocks is a keyword alias — without it the key
      // would silently drop under expansion (the exact defect class this module
      // exists to end).
      type: "@type",
      profile: { "@id": "dct:conformsTo", "@type": "@id" },
      title: { "@id": "dct:title" },
      // The projected resource's pointer to THIS representation's own node —
      // where the profile claim and hmd:Document typing live (a representation
      // conforms to the profile; the resource it depicts does not).
      document: { "@id": "schema:subjectOf" },
      about: { "@id": "schema:about", "@type": "@id" },
      descriptorUrl: { "@id": "wdrs:describedby", "@type": "@id" },
      state: { "@id": "schema:creativeWorkStatus" },
      rel: { "@id": "hmd:rel", "@type": "@id" },
      control: { "@id": "hmd:control", "@type": "@id", "@container": "@set" },
      condition: { "@id": "hmd:condition" },
      whenToUse: { "@id": "skos:scopeNote" },
      requires: { "@id": "dct:requires", "@container": "@set" },
      target: { "@id": "hmd:target", "@type": "@id" },
      // The signed artifact a control was DECLARED IN — the descriptor (canDecrypt /
      // renderView) vs the signed payload graph (its own controls). Preserves the
      // authority/provenance distinction so a client sees which controls came with
      // the signed content vs the transport descriptor.
      source: { "@id": "prov:wasDerivedFrom", "@type": "@id" },
      // A control's input/output contract — the SHACL shape a caller validates its
      // payload against (hydra:expects) + the response type (hydra:returns). Declared
      // as terms so the `expects:`/`returns:` control-block keys map to real predicates
      // instead of silently dropping under JSON-LD expansion.
      expects: { "@id": "hydra:expects", "@type": "@id" },
      returns: { "@id": "hydra:returns", "@type": "@id" }
    });
  }
});

// ../interego-native88/packages/core/src/kernel/index.ts
var CAN_DECRYPT_ACTION_IRIS;
var init_kernel = __esm({
  "../interego-native88/packages/core/src/kernel/index.ts"() {
    "use strict";
    init_composition();
    init_canonical_json();
    init_descriptor_shape();
    init_adapter();
    init_node_id();
    init_follow();
    init_turtle_parser();
    init_graph_digest();
    init_shacl_engine();
    init_fetch();
    init_retry();
    init_response_body();
    init_encryption();
    init_namespaces();
    init_affordance_extraction();
    init_action_identity();
    init_hypermedia();
    init_types3();
    init_affordance_extraction();
    init_hypermedia();
    init_hypermedia_markdown();
    CAN_DECRYPT_ACTION_IRIS = /* @__PURE__ */ new Set([
      `${CG}canDecrypt`,
      "iep:canDecrypt",
      // Defensive: callers occasionally over-IRI-prefix the action.
      `urn:iep:action:${CG}canDecrypt`
    ]);
  }
});

// ../interego-native88/packages/core/src/lattice/index.ts
var init_lattice = __esm({
  "../interego-native88/packages/core/src/lattice/index.ts"() {
    "use strict";
    init_adapter();
    init_node_id();
  }
});

// ../interego-native88/packages/core/src/mcp/output-schema.ts
var init_output_schema = __esm({
  "../interego-native88/packages/core/src/mcp/output-schema.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/mcp/http-mount.ts
var init_http_mount = __esm({
  "../interego-native88/packages/core/src/mcp/http-mount.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/net/guarded-fetch.ts
import { lookup } from "node:dns/promises";
function isPrivateIpv4(a, b, _c, _d) {
  if ([a, b, _c, _d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}
function expandIpv6(h) {
  let s = h;
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const q = [Number(dotted[2]), Number(dotted[3]), Number(dotted[4]), Number(dotted[5])];
    if (q.some((n) => n > 255)) return null;
    s = dotted[1] + (q[0] << 8 | q[1]).toString(16) + ":" + (q[2] << 8 | q[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? halves[1] ? halves[1].split(":") : [] : [];
  let groups;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head.map((x) => parseInt(x, 16));
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head.map((x) => parseInt(x || "0", 16)), ...Array(missing).fill(0), ...tail.map((x) => parseInt(x || "0", 16))];
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 65535)) return null;
  return groups;
}
function isPrivateIpv6(hRaw) {
  const h = hRaw.toLowerCase();
  const g = expandIpv6(h);
  if (!g) return true;
  if (g.slice(0, 7).every((x) => x === 0)) return g[7] === 0 || g[7] === 1;
  if ((g[0] & 65472) === 65152) return true;
  if ((g[0] & 65024) === 64512) return true;
  if ((g[0] & 65280) === 65280) return true;
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 65535;
  const compat = g.slice(0, 6).every((x) => x === 0);
  const nat64 = g[0] === 100 && g[1] === 65435 && g.slice(2, 6).every((x) => x === 0);
  if (mapped || compat || nat64) {
    return isPrivateIpv4(g[6] >> 8 & 255, g[6] & 255, g[7] >> 8 & 255, g[7] & 255);
  }
  return false;
}
function isPrivateHostname(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "" || h === "localhost" || h.endsWith(".localhost")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return isPrivateIpv4(Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4]));
  if (h.includes(":")) return isPrivateIpv6(h);
  return false;
}
async function assertSafeFetchTarget(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("target URL is not a valid absolute URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("target URL scheme must be http(s)");
  const host = u.hostname.toLowerCase();
  if (isPrivateHostname(host)) throw new Error("target host is private/loopback/link-local");
  const bare = host.replace(/^\[|\]$/g, "");
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":");
  if (!isIpLiteral) {
    let addrs;
    try {
      addrs = await lookup(bare, { all: true });
    } catch {
      return;
    }
    for (const a of addrs) {
      if (isPrivateHostname(a.address)) throw new Error("target host resolves to a private/loopback/link-local address");
    }
  }
}
async function safeFetch(url, init = {}, fetchFn, maxRedirects = 3) {
  const doFetch = fetchFn ?? globalThis.fetch;
  const method = String(init.method ?? "GET").toUpperCase();
  let target = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeFetchTarget(target);
    const resp = await doFetch(target, { ...init, redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return resp;
      if (method !== "GET" && method !== "HEAD") throw new Error(`refusing to follow a redirect on a ${method} request (SSRF guard)`);
      try {
        target = new URL(loc, target).toString();
      } catch {
        throw new Error("redirect Location is not a valid URL (SSRF guard)");
      }
      continue;
    }
    return resp;
  }
  throw new Error("too many redirects (SSRF guard)");
}
function guardedFetchFn(base) {
  const b = base ?? globalThis.fetch;
  return ((url, init) => safeFetch(url, init ?? {}, b));
}
var init_guarded_fetch = __esm({
  "../interego-native88/packages/core/src/net/guarded-fetch.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/identity/own-pod.ts
var init_own_pod = __esm({
  "../interego-native88/packages/core/src/identity/own-pod.ts"() {
    "use strict";
  }
});

// ../interego-native88/packages/core/src/index.ts
var init_src = __esm({
  "../interego-native88/packages/core/src/index.ts"() {
    "use strict";
    init_model();
    init_causality();
    init_rdf();
    init_rdf();
    init_rdf();
    init_rdf();
    init_rdf();
    init_validation();
    init_sparql();
    init_http();
    init_affordance();
    init_affordance();
    init_crypto();
    init_kernel();
    init_kernel();
    init_http();
    init_lattice();
    init_action_identity();
    init_output_schema();
    init_http_mount();
    init_canonical_json();
    init_descriptor_shape();
    init_guarded_fetch();
    init_own_pod();
  }
});

// ../interego-native88/applications/foxxi-content-intelligence/src/statement-store.ts
import { getHeapStatistics } from "node:v8";

// ../interego-native88/packages/solid/src/client.ts
init_src();
init_src();
init_src();
init_src();
init_src();
init_src();
init_src();
init_http();
init_http();
init_src();
init_http();
var MANIFEST_PATH = ".well-known/context-graphs";
var MANIFEST_HOT_LIMIT = 100;
var MANIFEST_HOT_KEEP = Math.floor(MANIFEST_HOT_LIMIT / 2);
var MANIFEST_HOT_MAX_BYTES = 1024 * 1024;
var byteLength = (s) => Buffer.byteLength(s, "utf8");
var MANIFEST_ARCHIVE_MAX_SEGMENTS = 512;
var TURTLE_CONTENT_TYPE = "text/turtle";
var TRIG_CONTENT_TYPE = "application/trig";
var ENVELOPE_CONTENT_TYPE = "application/jose+json";
function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}
var PREFIX_NAME = String.raw`[^\s:]*`;
function archiveFetchTarget(linkIri, manifestUrl) {
  let basename;
  try {
    basename = new URL(linkIri, manifestUrl).pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    return null;
  }
  if (!/^context-graphs-archive-\d+$/.test(basename)) return null;
  try {
    return new URL(basename, manifestUrl).href;
  } catch {
    return null;
  }
}
function parseManifestArchiveUrls(turtle, baseUrl) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const predicate = /(?:iep:manifestArchive|hydra:previous)\s*((?:<[^>]*>\s*,\s*)*<[^>]*>)/g;
  let m;
  while ((m = predicate.exec(turtle)) !== null) {
    for (const iri2 of m[1].matchAll(/<([^>]*)>/g)) {
      let abs;
      try {
        abs = new URL(iri2[1], baseUrl).href;
      } catch {
        continue;
      }
      if (!seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
    }
  }
  return out;
}
async function fetchManifestChain(manifestUrl, fetchFn, options = {}) {
  const maxSegments = options.maxSegments ?? MANIFEST_ARCHIVE_MAX_SEGMENTS;
  const stopAfter = options.stopAfterEntries;
  const stopBytes = options.stopAfterBytes;
  const hotResp = await withTransientRetry(async () => {
    const r = await fetchFn(manifestUrl, { method: "GET", headers: { "Accept": TURTLE_CONTENT_TYPE } });
    if (r.status >= 500) {
      throw new Error(`Failed to fetch manifest from ${manifestUrl}: ${r.status} ${r.statusText}`);
    }
    return r;
  }, { maxAttempts: 6, baseMs: 500 });
  if (!hotResp.ok) {
    return { hotBody: null, hotStatus: hotResp.status, archives: [], unreachable: [], complete: hotResp.status === 404, bounded: false };
  }
  const hotBody = await hotResp.text();
  const archives = [];
  const unreachable = [];
  const visited = /* @__PURE__ */ new Set([manifestUrl]);
  const targets = (turtle, base) => {
    const ok = [];
    const bad = [];
    for (const link of parseManifestArchiveUrls(turtle, base)) {
      const t = archiveFetchTarget(link, manifestUrl);
      if (t === null) bad.push(link);
      else ok.push(t);
    }
    return { ok, bad };
  };
  const fetchSegment = async (url) => {
    try {
      const r = await withTransientRetry(async () => {
        const resp = await fetchFn(url, { method: "GET", headers: { "Accept": TURTLE_CONTENT_TYPE } });
        if (resp.status >= 500) throw new Error(`archive GET <${url}> failed: ${resp.status} ${resp.statusText}`);
        return resp;
      }, { maxAttempts: 4, baseMs: 300 });
      return r.ok ? await r.text() : null;
    } catch {
      return null;
    }
  };
  const first = targets(hotBody, manifestUrl);
  unreachable.push(...first.bad);
  let frontier = first.ok.filter((u) => !visited.has(u));
  let truncated = false;
  if (stopAfter !== void 0 || stopBytes !== void 0) {
    let count = parseManifest(hotBody).length;
    let bytes = byteLength(hotBody);
    const pending = [...frontier].reverse();
    let leftUnread = false;
    const filled = () => stopAfter !== void 0 && count >= stopAfter || stopBytes !== void 0 && bytes >= stopBytes;
    while (pending.length > 0) {
      if (filled()) {
        leftUnread = true;
        break;
      }
      if (visited.size >= maxSegments) {
        truncated = true;
        break;
      }
      const url = pending.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      const body = await fetchSegment(url);
      if (body === null) {
        unreachable.push(url);
        continue;
      }
      archives.push({ url, body });
      count += parseManifest(body).length;
      bytes += byteLength(body);
      const onward = targets(body, url);
      unreachable.push(...onward.bad);
      for (const link of onward.ok) if (!visited.has(link) && !pending.includes(link)) pending.push(link);
    }
    if (pending.length > 0) leftUnread = true;
    return {
      hotBody,
      hotStatus: hotResp.status,
      archives,
      unreachable,
      // `complete` keeps its exact meaning: we read everything the index advertises. A bounded
      // walk that stopped early did not, and says so through `bounded` rather than by
      // pretending either way.
      complete: unreachable.length === 0 && !truncated && !leftUnread,
      bounded: leftUnread
    };
  }
  while (frontier.length > 0) {
    if (visited.size + frontier.length > maxSegments) {
      truncated = true;
      frontier = frontier.slice(0, Math.max(0, maxSegments - visited.size));
    }
    for (const u of frontier) visited.add(u);
    const fetched = await Promise.all(frontier.map(async (url) => ({ url, body: await fetchSegment(url) })));
    const next = [];
    for (const f of fetched) {
      if (f.body === null) {
        unreachable.push(f.url);
        continue;
      }
      archives.push({ url: f.url, body: f.body });
      const onward = targets(f.body, f.url);
      unreachable.push(...onward.bad);
      for (const link of onward.ok) {
        if (!visited.has(link) && !next.includes(link)) next.push(link);
      }
    }
    if (truncated) break;
    frontier = next;
  }
  return {
    hotBody,
    hotStatus: hotResp.status,
    archives,
    unreachable,
    complete: unreachable.length === 0 && !truncated,
    bounded: false
  };
}
async function fetchAllManifestEntries(manifestUrl, fetchFn, options = {}) {
  const chain = await fetchManifestChain(manifestUrl, fetchFn, options);
  const absolutize = (u) => {
    try {
      return new URL(u, manifestUrl).href;
    } catch {
      return u;
    }
  };
  const byUrl = /* @__PURE__ */ new Map();
  for (const a of chain.archives) {
    for (const e of parseManifest(a.body)) {
      byUrl.set(absolutize(e.descriptorUrl), {
        ...e,
        descriptorUrl: absolutize(e.descriptorUrl),
        ...Array.isArray(e.describes) ? { describes: e.describes.map(absolutize) } : {}
      });
    }
  }
  if (chain.hotBody !== null) {
    for (const e of parseManifest(chain.hotBody)) {
      byUrl.set(absolutize(e.descriptorUrl), {
        ...e,
        descriptorUrl: absolutize(e.descriptorUrl),
        ...Array.isArray(e.describes) ? { describes: e.describes.map(absolutize) } : {}
      });
    }
  }
  return {
    entries: [...byUrl.values()],
    complete: chain.complete,
    archivesFollowed: chain.archives.length,
    archivesUnreachable: chain.unreachable,
    hotStatus: chain.hotStatus,
    bounded: chain.bounded
  };
}
function parseManifest(turtle) {
  const entries = [];
  let current = null;
  const finalize = (e) => {
    const facets = [];
    const hasTrustFacetType = e.facetTypes.includes("Trust");
    if (e.trustLevel || e.issuer || hasTrustFacetType) {
      const tf = { type: "Trust" };
      if (e.trustLevel) tf.trustLevel = e.trustLevel;
      if (e.issuer) tf.issuer = e.issuer;
      facets.push(tf);
    }
    if (e.modalStatus) {
      facets.push({ type: "Semiotic", modalStatus: e.modalStatus });
    }
    const out = {
      descriptorUrl: e.descriptorUrl,
      ...e.cid !== void 0 ? { cid: e.cid } : {},
      describes: e.describes,
      facetTypes: e.facetTypes,
      ...e.validFrom !== void 0 ? { validFrom: e.validFrom } : {},
      ...e.validUntil !== void 0 ? { validUntil: e.validUntil } : {},
      ...e.modalStatus !== void 0 ? { modalStatus: e.modalStatus } : {},
      ...e.trustLevel !== void 0 ? { trustLevel: e.trustLevel } : {},
      ...e.issuer !== void 0 ? { issuer: e.issuer } : {},
      ...e.conformsTo !== void 0 ? { conformsTo: e.conformsTo } : {},
      ...e.supersedes !== void 0 ? { supersedes: e.supersedes } : {},
      ...e.pgslUri !== void 0 ? { pgslUri: e.pgslUri } : {},
      ...e.pgslLevel !== void 0 ? { pgslLevel: e.pgslLevel } : {},
      ...facets.length > 0 ? { facets } : {}
    };
    return out;
  };
  for (const rawLine of turtle.split("\n")) {
    const line = rawLine.trim();
    const entryMatch = line.match(/^<([^>]+)>\s+a\s+iep:ManifestEntry/);
    if (entryMatch) {
      if (current) {
        entries.push(finalize(current));
      }
      current = {
        descriptorUrl: entryMatch[1],
        describes: [],
        facetTypes: []
      };
      continue;
    }
    if (!current) continue;
    const cidMatch = line.match(/iep:contentCid\s+"([^"]+)"/);
    if (cidMatch) {
      current.cid = cidMatch[1];
    }
    const describesMatch = line.match(/iep:describes\s+<([^>]+)>/);
    if (describesMatch) {
      current.describes.push(describesMatch[1]);
    }
    const facetMatch = line.match(/iep:hasFacetType\s+iep:(\w+)/);
    if (facetMatch) {
      current.facetTypes.push(facetMatch[1]);
    }
    const fromMatch = line.match(/iep:validFrom\s+"([^"]+)"/);
    if (fromMatch) {
      current.validFrom = fromMatch[1];
    }
    const untilMatch = line.match(/iep:validUntil\s+"([^"]+)"/);
    if (untilMatch) {
      current.validUntil = untilMatch[1];
    }
    const modalMatch = line.match(/iep:modalStatus\s+iep:(\w+)/);
    if (modalMatch) {
      current.modalStatus = modalMatch[1];
    }
    const trustMatch = line.match(/iep:trustLevel\s+iep:(\w+)/);
    if (trustMatch) {
      current.trustLevel = trustMatch[1];
    }
    const issuerMatch = line.match(/iep:issuer\s+<([^>]+)>/);
    if (issuerMatch) {
      current.issuer = issuerMatch[1];
    }
    const conformsMatch = line.match(/dct:conformsTo\s+<([^>]+)>/);
    if (conformsMatch) {
      current.conformsTo = current.conformsTo ?? [];
      current.conformsTo.push(conformsMatch[1]);
    }
    const supersedesMatch = line.match(/iep:supersedes\s+<([^>]+)>/);
    if (supersedesMatch) {
      current.supersedes = current.supersedes ?? [];
      current.supersedes.push(supersedesMatch[1]);
    }
    const pgslUriMatch = line.match(/iep:pgslUri\s+<([^>]+)>/);
    if (pgslUriMatch) {
      current.pgslUri = pgslUriMatch[1];
    }
    const pgslLevelMatch = line.match(/iep:pgslLevel\s+"(\d+)"/);
    if (pgslLevelMatch) {
      current.pgslLevel = Number(pgslLevelMatch[1]);
    }
    if (line.endsWith(".")) {
      if (current) {
        entries.push(finalize(current));
        current = null;
      }
    }
  }
  if (current) {
    entries.push(finalize(current));
  }
  return entries;
}
function matchesFilter(entry, filter) {
  if (filter.facetType && !entry.facetTypes.includes(filter.facetType)) {
    return false;
  }
  if (filter.validFrom && entry.validUntil) {
    if (entry.validUntil < filter.validFrom) return false;
  }
  if (filter.validUntil && entry.validFrom) {
    if (entry.validFrom > filter.validUntil) return false;
  }
  if (filter.trustLevel) {
    if (!entry.facetTypes.includes("Trust") || entry.trustLevel !== filter.trustLevel) {
      return false;
    }
  }
  if (filter.modalStatus) {
    if (!entry.facetTypes.includes("Semiotic") || entry.modalStatus !== filter.modalStatus) {
      return false;
    }
  }
  if (filter.effectiveAt) {
    const t = filter.effectiveAt;
    if (entry.validFrom && entry.validFrom > t) return false;
    if (entry.validUntil && entry.validUntil < t) return false;
  }
  if (filter.graphIri) {
    if (!entry.describes.includes(filter.graphIri)) return false;
  }
  return true;
}
var DEFAULT_MAX_GRAPH_BYTES = 4 * 1024 * 1024;
function parseDistributionFromDescriptorTurtle(turtle) {
  let match = turtle.match(/iep:affordance\s*\[([\s\S]*?)\]/);
  if (!match) match = turtle.match(/iep:hasDistribution\s*\[([\s\S]*?)\]/);
  if (!match) return null;
  const block = match[1];
  const accessUrlMatch = block.match(/hydra:target\s+<([^>]+)>/) || block.match(/dcat:accessURL\s+<([^>]+)>/);
  const mediaTypeMatch = block.match(/dcat:mediaType\s+"([^"]+)"/);
  const encryptedMatch = block.match(/iep:encrypted\s+(true|false)/);
  const algoMatch = block.match(/iep:encryptionAlgorithm\s+"([^"]+)"/);
  const visibilityMatch = block.match(/iep:visibility\s+"(public|shared|private)"/);
  if (!accessUrlMatch || !mediaTypeMatch) return null;
  const result = {
    accessURL: accessUrlMatch[1],
    mediaType: mediaTypeMatch[1],
    encrypted: encryptedMatch?.[1] === "true"
  };
  if (algoMatch) result.encryptionAlgorithm = algoMatch[1];
  if (visibilityMatch) {
    result.visibility = visibilityMatch[1];
  }
  return result;
}
async function fetchGraphContent(graphUrl, options = {}) {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const r = await withTransientRetry(async () => {
    const resp = await fetchFn(graphUrl, { headers: { "Accept": `${ENVELOPE_CONTENT_TYPE}, ${TRIG_CONTENT_TYPE}, ${TURTLE_CONTENT_TYPE}` } });
    if (!resp.ok) throw new Error(`Failed to GET ${graphUrl}: ${resp.status} ${resp.statusText}`);
    return resp;
  });
  const mediaType = r.headers?.get("Content-Type") ?? "";
  const body = await r.text();
  const looksLikeEnvelope = graphUrl.endsWith(".envelope.jose.json") || mediaType.includes("jose") || mediaType.includes("json");
  if (!looksLikeEnvelope) {
    return { content: body, encrypted: false, mediaType };
  }
  let env;
  try {
    env = JSON.parse(body);
  } catch {
    return { content: body, encrypted: false, mediaType };
  }
  if (!env || env.algorithm !== "X25519-XSalsa20-Poly1305" || !Array.isArray(env.wrappedKeys)) {
    return { content: body, encrypted: false, mediaType };
  }
  if (options.openEnvelope) {
    return { content: await options.openEnvelope(env, r.url || graphUrl), encrypted: true, mediaType };
  }
  if (!options.recipientKeyPair) {
    return { content: null, encrypted: true, mediaType };
  }
  const plaintext = openEncryptedEnvelope(env, options.recipientKeyPair);
  return { content: plaintext, encrypted: true, mediaType };
}
async function discover(podUrl, filter, options = {}) {
  return (await discoverPage(podUrl, filter, options)).entries;
}
async function discoverPage(podUrl, filter, options = {}) {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const manifestUrl = `${pod}${MANIFEST_PATH}`;
  const all = await fetchAllManifestEntries(manifestUrl, fetchFn, {
    ...options.readWindow !== void 0 && options.readWindow >= 0 ? { stopAfterEntries: options.readWindow } : {},
    ...options.readBudgetBytes !== void 0 && options.readBudgetBytes >= 0 ? { stopAfterBytes: options.readBudgetBytes } : {}
  });
  if (all.hotStatus !== 200 && all.hotStatus !== 404) {
    throw new Error(
      `Failed to fetch manifest from ${manifestUrl}: ${all.hotStatus} (after transient retries)`
    );
  }
  if (all.archivesUnreachable.length > 0 || !all.complete && !all.bounded) {
    throw new Error(
      `Manifest at ${manifestUrl} is bounded and ${all.archivesUnreachable.length} archive segment(s) could not be read (${all.archivesUnreachable.join(", ")}); refusing to report a partial pod as complete`
    );
  }
  const entries = all.entries;
  const filtered = filter ? entries.filter((entry) => matchesFilter(entry, filter)) : entries;
  const sortMode = filter?.sort ?? "newest-first";
  let sorted = filtered;
  if (sortMode !== "unsorted") {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = a.validFrom ?? "";
      const bv = b.validFrom ?? "";
      if (sortMode === "newest-first") {
        if (!av && bv) return 1;
        if (av && !bv) return -1;
        if (av === bv) return 0;
        return av < bv ? 1 : -1;
      }
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      if (av === bv) return 0;
      return av < bv ? -1 : 1;
    });
    sorted = copy;
  }
  const shape = { bounded: all.bounded, archivesFollowed: all.archivesFollowed };
  if (filter?.limit !== void 0 && filter.limit >= 0) {
    return { entries: sorted.slice(0, filter.limit), ...shape };
  }
  return { entries: sorted, ...shape };
}

// ../interego-native88/packages/solid/src/naming.ts
init_src();
init_src();
init_src();
init_src();

// ../interego-native88/packages/solid/src/discovery.ts
init_src();
var AGENTS_CATALOG_MAX_BYTES = 256 * 1024;

// ../interego-native88/packages/solid/src/type-index.ts
init_http();

// ../interego-native88/packages/solid/src/encryption-keys.ts
init_http();

// ../interego-native88/packages/solid/src/directory.ts
init_src();
init_src();

// ../interego-native88/packages/solid/src/anchors.ts
init_src();

// ../interego-native88/packages/solid/src/retry.ts
init_http();

// ../interego-native88/packages/solid/src/affordance.ts
init_affordance();

// ../interego-native88/packages/solid/src/sdk.ts
init_src();
init_src();
init_src();
init_src();

// ../interego-native88/packages/solid/src/extensions.ts
init_src();
init_http();

// ../interego-native88/packages/pgsl/src/kernel-adapter.ts
init_src();
import { createHash as createHash3 } from "node:crypto";

// ../interego-native88/packages/pgsl/src/lattice.ts
init_src();
import { createHash as createHash2 } from "node:crypto";
function contentHash(input) {
  return createHash2("sha256").update(input, "utf-8").digest("hex");
}
function atomUri(value2) {
  const hash = contentHash(`atom:${String(value2)}`);
  return mintNodeId("atom", hash.slice(0, 40));
}
function fragmentUri(items, level) {
  const hash = contentHash(`fragment:L${level}:${items.join("|")}`);
  return mintNodeId("fragment", hash.slice(0, 40));
}
function fragmentKey(items) {
  return items.join("|");
}
function createPGSL(provenance, options) {
  return {
    atoms: /* @__PURE__ */ new Map(),
    fragments: /* @__PURE__ */ new Map(),
    nodes: /* @__PURE__ */ new Map(),
    defaultProvenance: provenance,
    lazyMode: options?.lazy,
    maxLevel: options?.maxLevel,
    deferredChains: options?.lazy ? /* @__PURE__ */ new Map() : void 0
  };
}
function deferredChainKey(atomUris) {
  return contentHash(`deferred:${atomUris.join("|")}`);
}
function buildDeferredLevels(pgsl, atomUris, _startLevel, targetLevel, provenance) {
  let currentLevel = atomUris.map((uri2) => ensureLevel1(pgsl, uri2, provenance));
  const effectiveMax = pgsl.maxLevel != null ? Math.min(targetLevel, pgsl.maxLevel) : targetLevel;
  for (let lvl = 1; lvl < effectiveMax; lvl++) {
    if (currentLevel.length <= 1) break;
    const nextLevel = [];
    for (let i = 0; i < currentLevel.length - 1; i++) {
      const pair = buildOverlappingPair(pgsl, currentLevel[i], currentLevel[i + 1], provenance);
      if (pair) nextLevel.push(pair);
    }
    if (nextLevel.length === 0) break;
    currentLevel = nextLevel;
  }
  return currentLevel;
}
function ensureBuilt(pgsl, uri2) {
  if (pgsl.nodes.has(uri2)) return;
  if (!pgsl.deferredChains || pgsl.deferredChains.size === 0) return;
  const prov = pgsl.defaultProvenance;
  for (const [key, atomUris] of pgsl.deferredChains) {
    const topLevel = atomUris.length;
    buildDeferredLevels(pgsl, atomUris, 2, topLevel, prov);
    if (pgsl.nodes.has(uri2)) {
      pgsl.deferredChains.delete(key);
      return;
    }
  }
}
function mintAtom(pgsl, value2, provenance) {
  const key = String(value2);
  const existing = pgsl.atoms.get(key);
  if (existing) return existing;
  const uri2 = atomUri(value2);
  const prov = provenance ?? pgsl.defaultProvenance;
  const atom = {
    kind: "Atom",
    uri: uri2,
    value: value2,
    level: 0,
    provenance: prov
  };
  pgsl.atoms.set(key, uri2);
  pgsl.nodes.set(uri2, atom);
  return uri2;
}
function ensureLevel1(pgsl, atomUri2, provenance) {
  const items = [atomUri2];
  const key = fragmentKey(items);
  const existing = pgsl.fragments.get(key);
  if (existing) return existing;
  const uri2 = fragmentUri(items, 1);
  const fragment = {
    kind: "Fragment",
    uri: uri2,
    level: 1,
    height: 1,
    items,
    provenance
  };
  pgsl.fragments.set(key, uri2);
  pgsl.nodes.set(uri2, fragment);
  return uri2;
}
function buildOverlappingPair(pgsl, leftUri, rightUri, provenance) {
  const leftNode = pgsl.nodes.get(leftUri);
  const rightNode = pgsl.nodes.get(rightUri);
  if (!leftNode || !rightNode) return null;
  if (leftNode.kind !== "Fragment" || rightNode.kind !== "Fragment") return null;
  const left = leftNode;
  const right = rightNode;
  if (left.level !== right.level) return null;
  const k = left.level;
  const overlapSize = k - 1;
  if (overlapSize < 0) return null;
  if (overlapSize === 0) {
    const items2 = [...left.items, ...right.items];
    const key2 = fragmentKey(items2);
    const existing2 = pgsl.fragments.get(key2);
    if (existing2) return existing2;
    const uri3 = fragmentUri(items2, k + 1);
    const fragment2 = {
      kind: "Fragment",
      uri: uri3,
      level: k + 1,
      height: Math.max(left.height, right.height) + 1,
      items: items2,
      left: leftUri,
      right: rightUri,
      provenance
    };
    pgsl.fragments.set(key2, uri3);
    pgsl.nodes.set(uri3, fragment2);
    return uri3;
  }
  const leftTail = left.items.slice(-overlapSize);
  const rightHead = right.items.slice(0, overlapSize);
  for (let i = 0; i < overlapSize; i++) {
    if (leftTail[i] !== rightHead[i]) return null;
  }
  const items = [...left.items, ...right.items.slice(overlapSize)];
  const key = fragmentKey(items);
  const existing = pgsl.fragments.get(key);
  if (existing) return existing;
  const uri2 = fragmentUri(items, k + 1);
  const fragment = {
    kind: "Fragment",
    uri: uri2,
    level: k + 1,
    height: Math.max(left.height, right.height) + 1,
    items,
    left: leftUri,
    right: rightUri,
    provenance
  };
  pgsl.fragments.set(key, uri2);
  pgsl.nodes.set(uri2, fragment);
  return uri2;
}
function ingest(pgsl, sequence, provenance) {
  const prov = provenance ?? pgsl.defaultProvenance;
  if (sequence.length === 0) {
    throw new Error("Cannot ingest empty sequence");
  }
  const atomUris = sequence.map((item) => {
    if (isPgslNodeId(item)) {
      return item;
    }
    return mintAtom(pgsl, item, prov);
  });
  if (atomUris.length === 1) {
    return ensureLevel1(pgsl, atomUris[0], prov);
  }
  let currentLevel = atomUris.map((uri2) => ensureLevel1(pgsl, uri2, prov));
  const eagerLimit = pgsl.lazyMode ? 2 : Infinity;
  const capLimit = pgsl.maxLevel != null ? pgsl.maxLevel : Infinity;
  const buildLimit = Math.min(eagerLimit, capLimit);
  let levelsBuilt = 1;
  while (currentLevel.length > 1) {
    if (levelsBuilt >= buildLimit) {
      if (pgsl.lazyMode && pgsl.deferredChains && atomUris.length > buildLimit) {
        const chainKey = deferredChainKey(atomUris);
        pgsl.deferredChains.set(chainKey, [...atomUris]);
      }
      break;
    }
    const nextLevel = [];
    for (let i = 0; i < currentLevel.length - 1; i++) {
      const pair = buildOverlappingPair(pgsl, currentLevel[i], currentLevel[i + 1], prov);
      if (pair) {
        nextLevel.push(pair);
      }
    }
    if (nextLevel.length === 0) {
      break;
    }
    currentLevel = nextLevel;
    levelsBuilt++;
  }
  return currentLevel[0];
}
function resolve(pgsl, uri2) {
  ensureBuilt(pgsl, uri2);
  const node = pgsl.nodes.get(uri2);
  if (!node) return `<unresolved:${uri2}>`;
  if (node.kind === "Atom") {
    return String(node.value);
  }
  const fragment = node;
  return fragment.items.map((item) => {
    const child = pgsl.nodes.get(item);
    if (!child) return `<unresolved:${item}>`;
    if (child.kind === "Atom") return String(child.value);
    if (child.kind === "Fragment" && child.level === 1) {
      const atom = pgsl.nodes.get(child.items[0]);
      return atom?.kind === "Atom" ? String(atom.value) : `<unresolved>`;
    }
    return resolve(pgsl, item);
  }).join(" ");
}

// ../interego-native88/packages/pgsl/src/category.ts
function pullbackSquare(pgsl, uri2) {
  const node = pgsl.nodes.get(uri2);
  if (!node || node.kind === "Atom") return null;
  const fragment = node;
  if (fragment.level < 2 || !fragment.left || !fragment.right) return null;
  const leftNode = pgsl.nodes.get(fragment.left);
  const rightNode = pgsl.nodes.get(fragment.right);
  if (!leftNode || !rightNode) return null;
  const overlapSize = fragment.level - 2;
  if (overlapSize === 0) {
    const overlapUri2 = leftNode.items[leftNode.items.length - 1];
    return {
      apex: uri2,
      left: fragment.left,
      right: fragment.right,
      overlap: overlapUri2,
      level: fragment.level
    };
  }
  const overlapItems = leftNode.items.slice(-overlapSize);
  const overlapKey = overlapItems.join("|");
  const overlapUri = pgsl.fragments.get(overlapKey);
  if (!overlapUri) return null;
  return {
    apex: uri2,
    left: fragment.left,
    right: fragment.right,
    overlap: overlapUri,
    level: fragment.level
  };
}

// ../interego-native88/packages/pgsl/src/kernel-adapter.ts
function sha256Hex3(input) {
  return createHash3("sha256").update(input, "utf-8").digest("hex");
}
var _adapterPgsl = null;
function adapterPgsl(provenance) {
  if (_adapterPgsl) return _adapterPgsl;
  _adapterPgsl = createPGSL({
    wasAttributedTo: provenance?.wasAttributedTo ?? "urn:iep:kernel",
    generatedAtTime: provenance?.generatedAtTime ?? (/* @__PURE__ */ new Date()).toISOString()
  });
  return _adapterPgsl;
}
function pgslLatticeAdapter() {
  return {
    mint(content, provenance) {
      const iri2 = mintAtom(adapterPgsl(provenance), content, normaliseProvenance(provenance));
      return {
        iri: iri2,
        level: 0,
        contentHash: sha256Hex3(`atom:${String(content)}`)
      };
    },
    promote(items, provenance) {
      if (items.length === 0) {
        throw new TypeError("promote() requires at least one item");
      }
      const pgsl = adapterPgsl(provenance);
      const apex = ingest(pgsl, items, normaliseProvenance(provenance));
      const node = pgsl.nodes.get(apex);
      const level = node && node.kind === "Fragment" ? node.level : Math.max(0, items.length - 1);
      return { apex, level };
    },
    decompose(fragmentIri) {
      const pgsl = adapterPgsl();
      const square = pullbackSquare(pgsl, fragmentIri);
      if (!square) return null;
      return {
        apex: square.apex,
        level: square.level,
        left: square.left,
        right: square.right,
        overlap: square.overlap
      };
    },
    resolve(iri2) {
      const pgsl = adapterPgsl();
      const node = pgsl.nodes.get(iri2);
      if (!node) return null;
      const value2 = resolve(pgsl, iri2);
      if (node.kind === "Atom") {
        return { iri: iri2, kind: "atom", level: 0, value: value2, items: [] };
      }
      const fragment = node;
      return {
        iri: iri2,
        kind: "fragment",
        level: fragment.level,
        value: value2,
        items: [...fragment.items]
      };
    }
  };
}
function normaliseProvenance(p) {
  if (!p) return void 0;
  return p;
}
setKernelLatticeAdapter(pgslLatticeAdapter());

// ../interego-native88/packages/pgsl/src/native-commit-store.ts
init_src();
import { createHash as createHash4 } from "node:crypto";
var NATIVE_COMMIT_MEDIA_TYPE = "application/vnd.interego.native-commit+json";
var JSON_TYPE = "application/json";
var PREFIX = "urn:interego:native-commit:v1:";
var HEAD = PREFIX + "head";
var ENTRY = PREFIX + "entry";
var LEAF = PREFIX + "leaf";
var BRANCH = PREFIX + "branch";
var EMPTY = PREFIX + "empty";
var PREVIOUS = PREFIX + "previous";
var REFERENCE = PREFIX + "reference";
var OPERATION = PREFIX + "operation";
var BYTES = PREFIX + "bytes";
var REVISION = /^sha256:[a-f0-9]{64}$/;
var DEFAULT_LIMIT = 8 * 1024 * 1024;
var LEAF_SIZE = 16;
var NativeCommitError = class extends Error {
  constructor(message, status = 503) {
    super(message);
    this.status = status;
    this.name = "NativeCommitError";
  }
  status;
};
var NativeCommitConflictError = class extends NativeCommitError {
  constructor() {
    super("Native head changed; read it again before retrying.", 412);
    this.name = "NativeCommitConflictError";
  }
};
function digest(bytes) {
  return "sha256:" + createHash4("sha256").update(bytes).digest("hex");
}
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function hashKey(key) {
  return createHash4("sha256").update(key).digest("hex");
}
function fail(message, status = 503) {
  throw new NativeCommitError(message, status);
}
function object(value2) {
  return !!value2 && typeof value2 === "object" && !Array.isArray(value2);
}
function publicKey(value2) {
  try {
    const bytes = Buffer.from(value2, "base64");
    return bytes.length === 32 && bytes.toString("base64") === value2;
  } catch {
    return false;
  }
}
function bounded(value2, max, label) {
  if (typeof value2 !== "string" || !value2 || Buffer.byteLength(value2) > max || /[\u0000-\u001f\u007f]/.test(value2)) fail("Invalid native " + label, 400);
}
function canonical(value2, depth = 0) {
  if (depth > 128) fail("Native value nesting exceeds capacity.", 413);
  if (value2 === null || typeof value2 === "boolean" || typeof value2 === "string") return JSON.stringify(value2);
  if (typeof value2 === "number" && Number.isFinite(value2)) return JSON.stringify(value2);
  if (Array.isArray(value2)) return "[" + value2.map((v) => canonical(v, depth + 1)).join(",") + "]";
  if (object(value2) && (Object.getPrototypeOf(value2) === Object.prototype || Object.getPrototypeOf(value2) === null)) {
    return "{" + Object.keys(value2).filter((k) => value2[k] !== void 0).sort().map((k) => JSON.stringify(k) + ":" + canonical(value2[k], depth + 1)).join(",") + "}";
  }
  return fail("Native values must contain finite JSON data.");
}
function uri(value2) {
  let result;
  try {
    result = new URL(value2);
  } catch {
    return fail("Invalid native resource URL.", 400);
  }
  if (result.protocol !== "https:" && !(result.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(result.hostname))) fail("Native transport requires HTTPS.", 400);
  if (result.username || result.password || result.search || result.hash || /%2f|%5c|%2e/i.test(result.pathname)) fail("Native resource URL contains unsafe components.", 400);
  return result;
}
function revisionFromEtag(value2) {
  return value2?.match(/^"(sha256:[a-f0-9]{64})(?:-[^"\r\n]{1,200})?"$/)?.[1] ?? null;
}
function literal(pgsl, value2) {
  return mintAtom(pgsl, value2);
}
function tuple(pgsl, values) {
  return ingest(pgsl, values.map((v) => literal(pgsl, v)));
}
function nativeUri(kind, hash, actual) {
  return actual === mintNodeId(kind, hash) || actual === "urn:pgsl:" + kind + ":" + hash;
}
function fields(artifact, id) {
  const node = artifact.nodes.get(id);
  if (node?.kind !== "Fragment") return fail("Native tuple is missing.");
  return node.items;
}
function value(artifact, id) {
  const node = id && artifact.nodes.get(id);
  if (!node || node.kind !== "Atom" || typeof node.value !== "string") return fail("Native tuple field is not a string atom.");
  return node.value;
}
function valueOrNull(artifact, id) {
  const node = id && artifact.nodes.get(id);
  return node && node.kind === "Atom" && typeof node.value === "string" ? node.value : null;
}
function validateNativeArtifact(artifact) {
  bounded(artifact.topUri, 4096, "top URI");
  const output = /* @__PURE__ */ new Map(), active = /* @__PURE__ */ new Set();
  const visit = (id, depth) => {
    if (output.has(id)) return;
    if (depth > 128 || output.size + active.size > 1e5) fail("Native lattice exceeds capacity.", 413);
    if (active.has(id)) fail("Native lattice contains a cycle.");
    const node = artifact.nodes.get(id);
    if (!node || node.uri !== id || !object(node.provenance) || typeof node.provenance.wasAttributedTo !== "string" || !Number.isFinite(Date.parse(node.provenance.generatedAtTime))) fail("Native lattice has a missing or malformed node.");
    active.add(id);
    if (node.kind === "Atom") {
      if (node.level !== 0 || node.encrypted !== void 0 || !["string", "number", "boolean"].includes(typeof node.value) || typeof node.value === "number" && !Number.isFinite(node.value)) fail("Invalid native atom.");
      const hash = createHash4("sha256").update("atom:" + String(node.value)).digest("hex").slice(0, 40);
      if (!nativeUri("atom", hash, id)) fail("Native atom content address mismatch.");
    } else if (node.kind === "Fragment") {
      if (!Array.isArray(node.items) || !Number.isSafeInteger(node.level) || node.level < 1 || node.items.length !== node.level || !Number.isSafeInteger(node.height) || node.height < 1) fail("Invalid native fragment.");
      const hash = createHash4("sha256").update("fragment:L" + node.level + ":" + node.items.join("|")).digest("hex").slice(0, 40);
      if (!nativeUri("fragment", hash, id)) fail("Native fragment content address mismatch.");
      for (const child of node.items) {
        if (typeof child !== "string") fail("Invalid native child URI.");
        visit(child, depth + 1);
      }
      if (node.level === 1 && (node.height !== 1 || node.left !== void 0 || node.right !== void 0)) fail("Native level-one fragment metadata is inconsistent.");
      if (node.level > 1) {
        if (!node.left || !node.right) fail("Native fragment lacks constituents.");
        visit(node.left, depth + 1);
        visit(node.right, depth + 1);
        const left = artifact.nodes.get(node.left), right = artifact.nodes.get(node.right);
        if (left?.kind !== "Fragment" || right?.kind !== "Fragment" || canonical(left.items) !== canonical(node.items.slice(0, -1)) || canonical(right.items) !== canonical(node.items.slice(1)) || node.height !== Math.max(left.height, right.height) + 1) fail("Native fragment constituents do not match its content.");
      }
    } else fail("Unknown native node kind.");
    active.delete(id);
    output.set(id, node);
  };
  visit(artifact.topUri, 0);
  return { topUri: artifact.topUri, nodes: output };
}
function serializeArtifact(input) {
  const checked = validateNativeArtifact(input);
  return Buffer.from(canonical({ topUri: checked.topUri, nodes: Object.fromEntries([...checked.nodes].sort(([a], [b]) => compareStrings(a, b))) }));
}
function createNativeByteArtifact(input) {
  bounded(input.owner, 4096, "owner");
  bounded(input.contentType, 200, "content type");
  const pgsl = createPGSL(input.provenance ?? { wasAttributedTo: input.owner, generatedAtTime: (/* @__PURE__ */ new Date()).toISOString() });
  const topUri = tuple(pgsl, [BYTES, input.owner, input.contentType, digest(input.bytes), Buffer.from(input.bytes).toString("base64")]);
  return { pgsl, topUri };
}
function readNativeByteArtifact(input) {
  const artifact = validateNativeArtifact(input), row = fields(artifact, artifact.topUri);
  if (row.length !== 5 || value(artifact, row[0]) !== BYTES) return fail("Not a native byte artifact.");
  const encoded = value(artifact, row[4]), bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || digest(bytes) !== value(artifact, row[3])) fail("Native byte content digest mismatch.");
  return { owner: value(artifact, row[1]), contentType: value(artifact, row[2]), bytes, sha256: digest(bytes) };
}
var NativeCommitStore = class {
  constructor(options) {
    this.options = options;
    const pod = uri(options.scope.pod), head = uri(options.scope.headUrl), container = uri(options.scope.artifactContainer);
    if (!pod.pathname.endsWith("/") || !container.pathname.endsWith("/") || head.origin !== pod.origin || container.origin !== pod.origin || !head.pathname.startsWith(pod.pathname) || !container.pathname.startsWith(pod.pathname)) fail("Native resources must remain in the authorized pod scope.", 400);
    bounded(options.scope.owner, 4096, "owner");
    this.scope = Object.freeze({ ...options.scope, pod: pod.href, headUrl: head.href, artifactContainer: container.href });
    this.recipients = [...new Set(options.recipientPublicKeys)].sort();
    if (!publicKey(options.ownerPublicKey) || this.recipients.some((k) => !publicKey(k)) || !this.recipients.includes(options.ownerPublicKey) || !this.recipients.includes(options.senderKeyPair.publicKey)) fail("Native storage requires explicit owner and stable reader recipients.", 400);
    this.limit = options.maxArtifactBytes ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1024 || this.limit > DEFAULT_LIMIT) fail("Invalid native capacity.", 400);
  }
  options;
  scope;
  recipients;
  limit;
  /** Capability discovery only; a verified no-op CAS is the adapter's write-authority check. */
  async ready() {
    let response;
    try {
      response = await this.options.fetch(this.scope.headUrl, { method: "OPTIONS", redirect: "manual" });
    } catch {
      return fail("Native atomic resource commits are unavailable.");
    }
    if (!response.ok || response.headers.get("Interego-Native-Commit") !== "1" || !response.headers.get("Accept-Put")?.split(",").map((s) => s.trim()).includes(NATIVE_COMMIT_MEDIA_TYPE)) fail("Native atomic resource commits are unavailable.");
  }
  target(url) {
    const parsed = uri(url), pod = uri(this.scope.pod);
    if (parsed.href !== url || parsed.origin !== pod.origin || !parsed.pathname.startsWith(pod.pathname)) fail("Native resource escaped its authorized pod.");
    return parsed;
  }
  async bytes(response, limit = this.limit) {
    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > limit) fail("Native representation exceeds capacity.", 413);
      return bytes;
    }
    const chunks = [];
    let size = 0;
    try {
      for (; ; ) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > limit) {
          await reader.cancel();
          fail("Native representation exceeds capacity.", 413);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
  async readRepresentation(url) {
    this.target(url);
    let response;
    try {
      response = await this.options.fetch(url, { headers: { Accept: JSON_TYPE, "Cache-Control": "no-cache" }, redirect: "manual" });
    } catch {
      return fail("Native resource read is unavailable.");
    }
    if (response.status === 404) return null;
    if (!response.ok || response.headers.get("Content-Type")?.split(";")[0]?.trim() !== JSON_TYPE) fail("Native resource is unreadable; no empty-state fallback.");
    const revision = revisionFromEtag(response.headers.get("ETag")), stated = response.headers.get("Interego-Revision"), bytes = await this.bytes(response);
    if (!revision || stated !== revision || response.headers.get("Interego-Body-Digest") !== digest(bytes)) fail("Native read metadata is not bound to its representation.");
    return { bytes, revision };
  }
  encrypt(artifact) {
    const bytes = Buffer.from(JSON.stringify(createEncryptedEnvelope(Buffer.from(serializeArtifact(artifact)).toString("utf8"), this.recipients, this.options.senderKeyPair)));
    if (bytes.length > this.limit) fail("Encrypted native artifact exceeds capacity.", 413);
    return bytes;
  }
  decrypt(bytes, expectedTop) {
    let envelope;
    try {
      envelope = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      return fail("Native ciphertext is malformed.");
    }
    const keys = Array.isArray(envelope?.wrappedKeys) ? envelope.wrappedKeys.map((k) => k.recipientPublicKey).sort() : [];
    if (envelope.version !== 1 || envelope.algorithm !== "X25519-XSalsa20-Poly1305" || canonical(keys) !== canonical(this.recipients)) fail("Native ciphertext recipient binding changed.");
    let plaintext;
    try {
      plaintext = openEncryptedEnvelope(envelope, this.options.senderKeyPair);
    } catch {
      return fail("Native ciphertext cannot be decrypted.");
    }
    if (!plaintext) return fail("Native ciphertext cannot be decrypted; no empty-state fallback.");
    let parsed;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      return fail("Native plaintext is malformed.");
    }
    if (!object(parsed) || typeof parsed.topUri !== "string" || !object(parsed.nodes) || Object.keys(parsed.nodes).length > 1e5 || expectedTop && parsed.topUri !== expectedTop) return fail("Native canonical top URI mismatch.");
    const nodes = new Map(Object.entries(parsed.nodes));
    const artifact = validateNativeArtifact({ topUri: parsed.topUri, nodes });
    if (artifact.nodes.size !== nodes.size || Buffer.from(serializeArtifact(artifact)).toString("utf8") !== plaintext) fail("Native lattice contains extra or noncanonical data.");
    return artifact;
  }
  resourceUrl(kind, bodyDigest) {
    if (!REVISION.test(bodyDigest)) return fail("Invalid native body digest.");
    return this.scope.artifactContainer + kind + "-" + bodyDigest.slice(7) + ".json";
  }
  expectedUrl(url, kind, bodyDigest) {
    this.target(url);
    if (url !== this.resourceUrl(kind, bodyDigest)) fail("Native immutable reference is not content bound.");
  }
  checkReference(reference) {
    this.expectedUrl(reference.resourceUrl, "artifact", reference.bodyDigest);
    if (!REVISION.test(reference.plaintextDigest) || !isPgslNodeId(reference.topUri)) fail("Native artifact reference is malformed.");
  }
  receipt(input, response, url, bytes, expectedRevision) {
    this.target(url);
    if (!object(input) || input.version !== 1 || input.status !== "committed" || input.expectedRevision !== expectedRevision || input.resource !== url || input.pod !== (this.options.storageDomain ?? "css") || input.path !== url || input.contentType !== JSON_TYPE || input.bodyDigest !== digest(bytes) || input.size !== bytes.length || typeof input.revision !== "string" || !REVISION.test(input.revision) || input.revision === expectedRevision || revisionFromEtag(response.headers.get("ETag")) !== input.revision || typeof input.updatedAt !== "number" || !Number.isFinite(input.updatedAt) || input.updatedAt < 0 || typeof input.topUri !== "string" || !isPgslNodeId(input.topUri) || typeof input.opaqueUri !== "string" || !isPgslNodeId(input.opaqueUri)) fail("Native commit receipt is not bound to the submitted resource.");
    return input;
  }
  async put(url, bytes, expectedRevision) {
    this.target(url);
    const headers = { "Content-Type": NATIVE_COMMIT_MEDIA_TYPE, Accept: JSON_TYPE };
    if (expectedRevision === null) headers["If-None-Match"] = "*";
    else {
      if (!REVISION.test(expectedRevision)) fail("Invalid native expected revision.", 400);
      headers["If-Match"] = '"' + expectedRevision + '"';
    }
    let response;
    try {
      response = await this.options.fetch(url, {
        method: "PUT",
        redirect: "manual",
        headers,
        body: JSON.stringify({ version: 1, expectedRevision, contentType: JSON_TYPE, bodyBase64: Buffer.from(bytes).toString("base64") })
      });
    } catch {
      return null;
    }
    if (response.status === 412) throw new NativeCommitConflictError();
    if (response.status >= 500) return null;
    if (!response.ok) fail("Native commit was not confirmed.");
    let receipt;
    try {
      receipt = JSON.parse(Buffer.from(await this.bytes(response, 32768)).toString("utf8"));
    } catch {
      return fail("Native commit acknowledgement is unreadable.");
    }
    return this.receipt(receipt, response, url, bytes, expectedRevision);
  }
  /** Every immutable representation is independently native CP-rooted before publication. */
  async stage(url, bytes, topUri) {
    try {
      await this.put(url, bytes, null);
    } catch (error) {
      if (!(error instanceof NativeCommitConflictError)) throw error;
    }
    const existing = await this.readRepresentation(url);
    if (!existing || !Buffer.from(existing.bytes).equals(Buffer.from(bytes))) fail("Native immutable artifact could not be read back unchanged.");
    this.decrypt(existing.bytes, topUri);
  }
  async persist(artifact) {
    const native = { topUri: artifact.topUri, nodes: artifact.pgsl.nodes }, bytes = this.encrypt(native), bodyDigest = digest(bytes);
    const reference = { resourceUrl: this.resourceUrl("artifact", bodyDigest), bodyDigest, plaintextDigest: digest(serializeArtifact(native)), topUri: artifact.topUri };
    await this.stage(reference.resourceUrl, bytes, reference.topUri);
    return reference;
  }
  async readArtifact(reference) {
    this.checkReference(reference);
    const stored = await this.readRepresentation(reference.resourceUrl);
    if (!stored || digest(stored.bytes) !== reference.bodyDigest) return fail("Committed native artifact is unavailable or changed.");
    const artifact = this.decrypt(stored.bytes, reference.topUri);
    if (digest(serializeArtifact(artifact)) !== reference.plaintextDigest) fail("Native artifact plaintext binding changed.");
    return artifact;
  }
  referenceTuple(pgsl, tag, key, reference) {
    return tuple(pgsl, [tag, key, reference.resourceUrl, reference.bodyDigest, reference.plaintextDigest, reference.topUri]);
  }
  parseReference(artifact, id, tag) {
    const row = fields(artifact, id);
    if (row.length !== 6 || value(artifact, row[0]) !== tag) fail("Native reference tuple is malformed.");
    const reference = { resourceUrl: value(artifact, row[2]), bodyDigest: value(artifact, row[3]), plaintextDigest: value(artifact, row[4]), topUri: value(artifact, row[5]) };
    this.checkReference(reference);
    return { key: value(artifact, row[1]), reference };
  }
  async indexNode(reference, prefix) {
    const artifact = await this.readArtifact(reference), row = fields(artifact, artifact.topUri), tag = value(artifact, row[0]);
    if (row.length < 2 || row.length > LEAF_SIZE + 1) fail("Native index node exceeds its bounded fanout.");
    if (tag === LEAF) {
      const entries = /* @__PURE__ */ new Map();
      for (const id of row.slice(1)) {
        const entry = this.parseReference(artifact, id, ENTRY);
        bounded(entry.key, 4300, "index key");
        if (!hashKey(entry.key).startsWith(prefix) || entries.has(entry.key)) fail("Native index leaf binding changed.");
        entries.set(entry.key, entry.reference);
      }
      return { kind: "leaf", entries };
    }
    if (tag !== BRANCH || prefix.length >= 64) return fail("Native index branch is malformed.");
    const children2 = /* @__PURE__ */ new Map();
    for (const id of row.slice(1)) {
      const child = this.parseReference(artifact, id, ENTRY);
      if (!/^[a-f0-9]$/.test(child.key) || children2.has(child.key)) fail("Native index branch binding changed.");
      children2.set(child.key, child.reference);
    }
    return { kind: "branch", children: children2 };
  }
  async saveIndex(node) {
    const pgsl = createPGSL({ wasAttributedTo: this.scope.owner, generatedAtTime: (/* @__PURE__ */ new Date()).toISOString() });
    const entries = node.kind === "leaf" ? node.entries : node.children;
    const rows = [...entries].sort(([a], [b]) => compareStrings(a, b)).map(([key, reference]) => this.referenceTuple(pgsl, ENTRY, key, reference));
    const topUri = ingest(pgsl, [literal(pgsl, node.kind === "leaf" ? LEAF : BRANCH), ...rows]);
    return this.persist({ pgsl, topUri });
  }
  async buildIndex(entries, prefix) {
    if (!entries.size) return null;
    if (entries.size <= LEAF_SIZE) return this.saveIndex({ kind: "leaf", entries });
    if (prefix.length >= 64) return fail("Native index hash collision; existing state was not changed.");
    const groups = /* @__PURE__ */ new Map();
    for (const [key, value2] of entries) {
      const nibble = hashKey(key)[prefix.length];
      if (!groups.has(nibble)) groups.set(nibble, /* @__PURE__ */ new Map());
      groups.get(nibble).set(key, value2);
    }
    const children2 = /* @__PURE__ */ new Map();
    for (const [nibble, group] of [...groups].sort(([a], [b]) => compareStrings(a, b))) children2.set(nibble, await this.buildIndex(group, prefix + nibble));
    return this.saveIndex({ kind: "branch", children: children2 });
  }
  async updateIndex(root, changes, prefix = "") {
    const node = root ? await this.indexNode(root, prefix) : { kind: "leaf", entries: /* @__PURE__ */ new Map() };
    if (node.kind === "leaf") {
      const entries = new Map(node.entries);
      for (const [key, value2] of changes) {
        if (!hashKey(key).startsWith(prefix)) fail("Native index mutation escaped its branch.");
        if (value2) entries.set(key, value2);
        else entries.delete(key);
      }
      return this.buildIndex(entries, prefix);
    }
    const children2 = new Map(node.children), groups = /* @__PURE__ */ new Map();
    for (const [key, value2] of changes) {
      if (!hashKey(key).startsWith(prefix)) fail("Native index mutation escaped its branch.");
      const nibble = hashKey(key)[prefix.length];
      if (!groups.has(nibble)) groups.set(nibble, /* @__PURE__ */ new Map());
      groups.get(nibble).set(key, value2);
    }
    for (const [nibble, group] of [...groups].sort(([a], [b]) => compareStrings(a, b))) {
      const child = await this.updateIndex(children2.get(nibble) ?? null, group, prefix + nibble);
      if (child) children2.set(nibble, child);
      else children2.delete(nibble);
    }
    return children2.size ? this.saveIndex({ kind: "branch", children: children2 }) : null;
  }
  async lookup(root, key) {
    let reference = root, prefix = "";
    while (reference) {
      const node = await this.indexNode(reference, prefix);
      if (node.kind === "leaf") return node.entries.get(key) ?? null;
      const nibble = hashKey(key)[prefix.length];
      prefix += nibble;
      reference = node.children.get(nibble) ?? null;
    }
    return null;
  }
  async records(root) {
    const result = /* @__PURE__ */ new Map(), seen = /* @__PURE__ */ new Set();
    const walk = async (reference, prefix) => {
      if (seen.has(reference.resourceUrl)) fail("Native index contains a cycle or duplicate branch.");
      seen.add(reference.resourceUrl);
      const node = await this.indexNode(reference, prefix);
      if (node.kind === "leaf") {
        for (const [key, ref] of node.entries) if (key.startsWith("record:")) result.set(key.slice(7), ref);
        return;
      }
      for (const [nibble, child] of node.children) await walk(child, prefix + nibble);
    };
    if (root) await walk(root, "");
    return result;
  }
  empty() {
    return { scope: this.scope, revision: null, reference: null, operationId: null, records: /* @__PURE__ */ new Map(), logicalDigest: "", createdAt: "", previous: null, index: null };
  }
  decodeHead(bytes, revision, expectedTop) {
    const artifact = this.decrypt(bytes, expectedTop), row = fields(artifact, artifact.topUri);
    if (row.length !== 9 || value(artifact, row[0]) !== HEAD || value(artifact, row[1]) !== this.scope.pod || value(artifact, row[2]) !== this.scope.owner || value(artifact, row[3]) !== this.scope.headUrl) return fail("Native head scope/owner binding changed.");
    const operationId = value(artifact, row[4]), logicalDigest = value(artifact, row[5]), createdAt = value(artifact, row[6]);
    bounded(operationId, 200, "operation ID");
    if (!REVISION.test(logicalDigest) || !Number.isFinite(Date.parse(createdAt))) fail("Native commit identity is malformed.");
    let previous = null;
    if (valueOrNull(artifact, row[7]) !== EMPTY) {
      const prior = fields(artifact, row[7]);
      if (prior.length !== 4 || value(artifact, prior[0]) !== PREVIOUS) fail("Native previous-head reference is malformed.");
      previous = { revision: value(artifact, prior[1]), commitUrl: value(artifact, prior[2]), topUri: value(artifact, prior[3]) };
      if (!REVISION.test(previous.revision)) fail("Native previous revision is malformed.");
    }
    const index = valueOrNull(artifact, row[8]) === EMPTY ? null : this.parseReference(artifact, row[8], REFERENCE).reference;
    return { scope: this.scope, revision, reference: { revision, commitUrl: this.resourceUrl("commit", digest(bytes)), topUri: artifact.topUri }, operationId, records: /* @__PURE__ */ new Map(), logicalDigest, createdAt, previous, index };
  }
  async archived(reference) {
    if (!REVISION.test(reference.revision)) return fail("Invalid native historical revision.");
    const match = reference.commitUrl.match(/\/commit-([a-f0-9]{64})\.json$/);
    if (!match) return fail("Invalid native commit reference.");
    this.expectedUrl(reference.commitUrl, "commit", "sha256:" + match[1]);
    const stored = await this.readRepresentation(reference.commitUrl);
    if (!stored || digest(stored.bytes) !== "sha256:" + match[1]) return fail("Native commit history is unavailable or changed.");
    return this.decodeHead(stored.bytes, reference.revision, reference.topUri);
  }
  async current() {
    const stored = await this.readRepresentation(this.scope.headUrl);
    if (!stored) return this.empty();
    const head = this.decodeHead(stored.bytes, stored.revision);
    const archived = await this.archived(head.reference);
    if (archived.logicalDigest !== head.logicalDigest || archived.operationId !== head.operationId) fail("Native head is not backed by its immutable commit.");
    return head;
  }
  async complete(head) {
    return { ...head, records: await this.records(head.index) };
  }
  async readHead() {
    return this.complete(await this.current());
  }
  async operation(operationId, current) {
    if (current.operationId === operationId) return current;
    const ref = await this.lookup(current.index, "operation:" + operationId);
    if (!ref) return null;
    const artifact = await this.readArtifact(ref), row = fields(artifact, artifact.topUri);
    if (row.length !== 6 || value(artifact, row[0]) !== OPERATION || value(artifact, row[1]) !== operationId) return fail("Native operation index is malformed.");
    const reference = { revision: value(artifact, row[3]), commitUrl: value(artifact, row[4]), topUri: value(artifact, row[5]) };
    const prior = await this.archived(reference);
    if (prior.operationId !== operationId || prior.logicalDigest !== value(artifact, row[2])) fail("Native operation receipt binding changed.");
    return prior;
  }
  async readSnapshotAt(reference) {
    const current = await this.current();
    if (canonical(current.reference) === canonical(reference)) return this.complete(current);
    const archived = await this.archived(reference);
    const retained = await this.operation(archived.operationId, current);
    if (!retained || canonical(retained.reference) !== canonical(reference)) return fail("Historical snapshot is not in the committed native index.");
    return this.complete(retained);
  }
  async result(head, replayed, receipt) {
    if (!head.reference || !head.operationId) return fail("Native commit receipt lacks a committed head.");
    return {
      operationId: head.operationId,
      scope: this.scope,
      previousHead: head.previous,
      head: head.reference,
      createdAt: head.createdAt,
      replayed,
      snapshot: await this.complete(head),
      resourceReceipt: receipt
    };
  }
  async commit(request) {
    bounded(request.operationId, 200, "operation ID");
    if (canonical(request.expected.scope) !== canonical(this.scope) || !Array.isArray(request.changes) || request.changes.length > 1e3) fail("Native mutation scope or capacity is invalid.", 400);
    const changes = [...request.changes].sort((a, b) => compareStrings(a.key, b.key)), keys = /* @__PURE__ */ new Set();
    for (const change of changes) {
      bounded(change.key, 4096, "record key");
      if (keys.has(change.key)) fail("Native mutation repeats a record key.", 400);
      keys.add(change.key);
      if (change.artifact) validateNativeArtifact({ topUri: change.artifact.topUri, nodes: change.artifact.pgsl.nodes });
    }
    const logicalDigest = digest(canonical({ scope: this.scope, changes: changes.map((c) => ({ key: c.key, plaintextDigest: c.artifact ? digest(serializeArtifact({ topUri: c.artifact.topUri, nodes: c.artifact.pgsl.nodes })) : null })) }));
    const current = await this.current(), prior = await this.operation(request.operationId, current);
    if (prior) {
      if (prior.logicalDigest !== logicalDigest) fail("Native operation ID was already committed with different content.", 409);
      return this.result(prior, true, null);
    }
    if (current.revision !== request.expected.revision || canonical(current.reference) !== canonical(request.expected.reference)) throw new NativeCommitConflictError();
    await this.ready();
    const indexChanges = /* @__PURE__ */ new Map();
    for (const change of changes) indexChanges.set("record:" + change.key, change.artifact ? await this.persist(change.artifact) : null);
    if (current.reference) {
      const pgsl2 = createPGSL({ wasAttributedTo: this.scope.owner, generatedAtTime: (/* @__PURE__ */ new Date()).toISOString() });
      const topUri2 = tuple(pgsl2, [OPERATION, current.operationId, current.logicalDigest, current.reference.revision, current.reference.commitUrl, current.reference.topUri]);
      indexChanges.set("operation:" + current.operationId, await this.persist({ pgsl: pgsl2, topUri: topUri2 }));
    }
    const index = indexChanges.size ? await this.updateIndex(current.index, indexChanges) : current.index;
    const createdAt = (/* @__PURE__ */ new Date()).toISOString(), pgsl = createPGSL({ wasAttributedTo: this.scope.owner, generatedAtTime: createdAt });
    const previous = current.reference ? tuple(pgsl, [PREVIOUS, current.reference.revision, current.reference.commitUrl, current.reference.topUri]) : literal(pgsl, EMPTY);
    const indexTuple = index ? this.referenceTuple(pgsl, REFERENCE, "index", index) : literal(pgsl, EMPTY);
    const topUri = ingest(pgsl, [
      literal(pgsl, HEAD),
      literal(pgsl, this.scope.pod),
      literal(pgsl, this.scope.owner),
      literal(pgsl, this.scope.headUrl),
      literal(pgsl, request.operationId),
      literal(pgsl, logicalDigest),
      literal(pgsl, createdAt),
      previous,
      indexTuple
    ]);
    const bytes = this.encrypt({ topUri, nodes: pgsl.nodes }), commitUrl = this.resourceUrl("commit", digest(bytes));
    await this.stage(commitUrl, bytes, topUri);
    let receipt;
    try {
      receipt = await this.put(this.scope.headUrl, bytes, current.revision);
    } catch (error) {
      if (!(error instanceof NativeCommitConflictError)) throw error;
      const winner = await this.operation(request.operationId, await this.current());
      if (winner && winner.logicalDigest === logicalDigest) return this.result(winner, true, null);
      throw error;
    }
    if (!receipt) {
      const recovered = await this.operation(request.operationId, await this.current());
      if (!recovered || recovered.logicalDigest !== logicalDigest) return fail("Native head acknowledgement is uncertain; retry the same operation ID.");
      return this.result(recovered, true, null);
    }
    const committed = this.decodeHead(bytes, receipt.revision, topUri), actual = await this.readRepresentation(this.scope.headUrl);
    if (!actual || actual.revision !== receipt.revision || !Buffer.from(actual.bytes).equals(Buffer.from(bytes))) {
      const ancestor = await this.operation(request.operationId, await this.current());
      if (!ancestor || ancestor.reference?.revision !== receipt.revision || ancestor.reference.topUri !== topUri || ancestor.logicalDigest !== logicalDigest) return fail("Native committed head could not be verified unchanged.");
    }
    this.decrypt(bytes, topUri);
    return this.result(committed, false, receipt);
  }
};

// ../interego-native88/packages/pgsl/src/describe.ts
init_src();

// ../interego-native88/packages/pgsl/src/rdf.ts
init_src();
var PGSL_NS = "https://markjspivey-xwisee.github.io/interego/ns/pgsl#";
var PGSLClass = {
  Node: `${PGSL_NS}Node`,
  Atom: `${PGSL_NS}Atom`,
  Fragment: `${PGSL_NS}Fragment`,
  PullbackSquare: `${PGSL_NS}PullbackSquare`,
  ConstituentMorphism: `${PGSL_NS}ConstituentMorphism`,
  Lattice: `${PGSL_NS}Lattice`
};
var PGSLProp = {
  value: `${PGSL_NS}value`,
  level: `${PGSL_NS}level`,
  height: `${PGSL_NS}height`,
  item: `${PGSL_NS}item`,
  itemList: `${PGSL_NS}itemList`,
  leftConstituent: `${PGSL_NS}leftConstituent`,
  rightConstituent: `${PGSL_NS}rightConstituent`,
  overlap: `${PGSL_NS}overlap`,
  apex: `${PGSL_NS}apex`,
  constituentOf: `${PGSL_NS}constituentOf`,
  contains: `${PGSL_NS}contains`,
  atomCount: `${PGSL_NS}atomCount`,
  fragmentCount: `${PGSL_NS}fragmentCount`,
  maxLevel: `${PGSL_NS}maxLevel`
};

// ../interego-native88/packages/pgsl/src/geometric.ts
var EMBED_MAX_BYTES = 2 * 1024 * 1024;

// ../interego-native88/packages/pgsl/src/ontological-inference.ts
init_src();
import { readFileSync, existsSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
var FALLBACK_SYNONYM_GROUPS = {
  // Problems/issues
  "issue": ["problem", "issue", "trouble", "difficulty", "malfunction", "defect", "fault", "error", "bug", "failure", "breakdown", "glitch"],
  // Fixing
  "fix": ["fix", "repair", "resolve", "solve", "address", "correct", "remedy", "patch", "mend", "restore"],
  // Start/begin
  "start": ["start", "begin", "commence", "initiate", "launch", "kick off", "embark"],
  // End/finish
  "finish": ["finish", "end", "complete", "conclude", "finalize", "wrap up", "close"],
  // Like/enjoy
  "like": ["like", "enjoy", "love", "prefer", "favor", "appreciate", "fond of"],
  // Dislike
  "dislike": ["dislike", "hate", "detest", "loathe", "despise", "can't stand"],
  // Buy/purchase
  "buy": ["buy", "purchase", "acquire", "get", "obtain", "order", "pick up"],
  // Travel/move
  "travel": ["travel", "go", "visit", "trip", "journey", "commute", "drive", "fly", "ride"],
  // Say/tell
  "say": ["say", "tell", "mention", "state", "explain", "describe", "report", "discuss", "talk about"],
  // Work/function
  "work": ["work", "function", "operate", "run", "perform", "serve"],
  // Not working
  "not_working": ["not working", "not functioning", "broken", "malfunctioning", "down", "crashed", "failed", "unresponsive", "out of order"],
  // Cost/price
  "cost": ["cost", "price", "fee", "charge", "expense", "rate", "amount"],
  // Big/large
  "big": ["big", "large", "huge", "enormous", "massive", "substantial", "significant"],
  // Small/little
  "small": ["small", "little", "tiny", "minor", "slight", "minimal"],
  // Good/positive
  "good": ["good", "great", "excellent", "wonderful", "fantastic", "amazing", "positive", "nice", "pleasant"],
  // Bad/negative
  "bad": ["bad", "terrible", "awful", "horrible", "poor", "negative", "disappointing"],
  // Help/assist
  "help": ["help", "assist", "support", "aid", "guide"],
  // Change/modify
  "change": ["change", "modify", "alter", "adjust", "update", "revise", "amend"],
  // Create/make
  "create": ["create", "make", "build", "develop", "design", "construct", "produce", "generate"],
  // Remove/delete
  "remove": ["remove", "delete", "eliminate", "discard", "drop", "clear", "erase"]
};
var FALLBACK_IS_A = {
  // Vehicles
  "car": ["vehicle", "transport", "automobile"],
  "truck": ["vehicle", "transport"],
  "bike": ["vehicle", "transport"],
  "bus": ["vehicle", "transport"],
  // Car components
  "gps": ["car_component", "electronics", "navigation", "device"],
  "gps_system": ["car_component", "electronics", "navigation", "device"],
  "engine": ["car_component", "mechanical", "powertrain"],
  "brake": ["car_component", "safety", "mechanical"],
  "brakes": ["car_component", "safety", "mechanical"],
  "tire": ["car_component", "wheel"],
  "tires": ["car_component", "wheel"],
  "battery": ["car_component", "electrical", "power"],
  "transmission": ["car_component", "mechanical", "powertrain"],
  "ac": ["car_component", "climate", "comfort"],
  "air_conditioning": ["car_component", "climate", "comfort"],
  "radio": ["car_component", "entertainment", "electronics"],
  "headlight": ["car_component", "lighting", "safety"],
  "windshield": ["car_component", "glass", "safety"],
  // Tech
  "laptop": ["computer", "device", "electronics"],
  "phone": ["device", "electronics", "communication"],
  "smartphone": ["phone", "device", "electronics"],
  "tablet": ["device", "electronics", "computer"],
  "app": ["software", "application", "program"],
  "website": ["software", "online_service", "digital"],
  // People
  "doctor": ["professional", "medical", "healthcare"],
  "teacher": ["professional", "education", "instructor"],
  "engineer": ["professional", "technical"],
  "manager": ["professional", "leadership"],
  // Places
  "restaurant": ["place", "food", "dining", "business"],
  "hospital": ["place", "medical", "healthcare", "building"],
  "school": ["place", "education", "building"],
  "office": ["place", "work", "building"],
  "gym": ["place", "fitness", "exercise", "building"],
  "park": ["place", "outdoor", "recreation"],
  // Events
  "service": ["event", "maintenance", "appointment"],
  "meeting": ["event", "work", "discussion"],
  "appointment": ["event", "scheduled"],
  "party": ["event", "social", "celebration"],
  "wedding": ["event", "ceremony", "celebration"],
  "concert": ["event", "entertainment", "music"],
  "vacation": ["event", "travel", "leisure"],
  "trip": ["event", "travel"],
  // Activities
  "cooking": ["activity", "food", "hobby"],
  "reading": ["activity", "hobby", "education"],
  "exercise": ["activity", "fitness", "health"],
  "running": ["exercise", "activity", "fitness"],
  "swimming": ["exercise", "activity", "fitness", "sport"],
  // Emotions
  "happy": ["emotion", "positive", "feeling"],
  "sad": ["emotion", "negative", "feeling"],
  "angry": ["emotion", "negative", "feeling"],
  "excited": ["emotion", "positive", "feeling"],
  "worried": ["emotion", "negative", "feeling", "anxiety"],
  "stressed": ["emotion", "negative", "feeling", "anxiety"],
  // Health
  "cold": ["illness", "health_issue", "respiratory"],
  "flu": ["illness", "health_issue", "respiratory"],
  "headache": ["symptom", "health_issue", "pain"],
  "pain": ["symptom", "health_issue"],
  "fever": ["symptom", "health_issue"]
};
var FALLBACK_PART_OF = {
  "gps": ["car", "vehicle"],
  "gps_system": ["car", "vehicle"],
  "engine": ["car", "vehicle"],
  "brake": ["car", "vehicle"],
  "brakes": ["car", "vehicle"],
  "tire": ["car", "vehicle"],
  "tires": ["car", "vehicle"],
  "battery": ["car", "vehicle", "phone", "laptop"],
  "screen": ["phone", "laptop", "tablet", "device"],
  "keyboard": ["laptop", "computer"],
  "wheel": ["car", "vehicle", "bike"],
  "door": ["car", "building", "house"],
  "window": ["car", "building", "house"],
  "roof": ["car", "building", "house"],
  "seat": ["car", "vehicle", "chair"]
};
var FALLBACK_CAUSES = {
  "malfunction": ["issue", "problem", "breakdown", "failure"],
  "accident": ["injury", "damage", "issue"],
  "rain": ["wet", "delay", "flood"],
  "traffic": ["delay", "late", "stress"],
  "stress": ["anxiety", "health_issue", "insomnia"],
  "exercise": ["fitness", "health", "energy"],
  "service": ["fix", "maintenance", "repair"],
  "repair": ["fix", "working", "resolved"]
};
var PGSL_NS2 = "https://markjspivey-xwisee.github.io/interego/ns/pgsl#";
var SKOS_NS = "http://www.w3.org/2004/02/skos/core#";
var TERM_BASE = "https://markjspivey-xwisee.github.io/interego/ns/pgsl-lexicon#";
function resolveNsDir() {
  const configured = process.env["INTEREGO_NS_DIR"]?.trim();
  if (configured) return existsSync(configured) ? configured : void 0;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = joinPath(dir, "docs", "ns");
    if (existsSync(candidate)) return candidate;
    const parent = joinPath(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
function localTerm(iri2) {
  return iri2.startsWith(TERM_BASE) ? iri2.slice(TERM_BASE.length) : void 0;
}
function parseLexicon(turtle) {
  let doc;
  try {
    doc = parseTrig(turtle);
  } catch {
    return void 0;
  }
  const synonymGroups = {};
  const isA = {};
  const partOf = {};
  const causes = {};
  const collectIris = (subj, predicate) => (subj.properties.get(predicate) ?? []).map((t) => t.kind === "iri" ? localTerm(t.iri) : void 0).filter((t) => t !== void 0);
  for (const subj of doc.subjects) {
    if (typeof subj.subject !== "string") continue;
    const self2 = localTerm(subj.subject);
    if (self2 === void 0) continue;
    const pref = subj.properties.get(`${SKOS_NS}prefLabel`)?.[0];
    const alts = (subj.properties.get(`${SKOS_NS}altLabel`) ?? []).map((t) => t.kind === "literal" ? t.value : void 0).filter((v) => v !== void 0);
    if (pref?.kind === "literal" && alts.length > 0) synonymGroups[pref.value] = alts;
    const broader = collectIris(subj, `${SKOS_NS}broader`);
    if (broader.length > 0) isA[self2] = broader;
    const parts = collectIris(subj, `${PGSL_NS2}partOf`);
    if (parts.length > 0) partOf[self2] = parts;
    const effects = collectIris(subj, `${PGSL_NS2}causes`);
    if (effects.length > 0) causes[self2] = effects;
  }
  if (Object.keys(synonymGroups).length === 0 || Object.keys(isA).length === 0) return void 0;
  return { synonymGroups, isA, partOf, causes };
}
function loadLexicon() {
  const ns = resolveNsDir();
  const file = ns ? joinPath(ns, "pgsl-lexicon.ttl") : void 0;
  if (file && existsSync(file)) {
    try {
      const parsed = parseLexicon(readFileSync(file, "utf8"));
      if (parsed) return { ...parsed, source: "published" };
    } catch {
    }
  }
  return {
    synonymGroups: FALLBACK_SYNONYM_GROUPS,
    isA: FALLBACK_IS_A,
    partOf: FALLBACK_PART_OF,
    causes: FALLBACK_CAUSES,
    source: "fallback"
  };
}
var LEXICON = loadLexicon();
var SYNONYM_GROUPS = LEXICON.synonymGroups;
var IS_A = LEXICON.isA;
var PART_OF = LEXICON.partOf;
var CAUSES = LEXICON.causes;
var SYNONYM_LOOKUP = /* @__PURE__ */ new Map();
for (const [canonical2, synonyms] of Object.entries(SYNONYM_GROUPS)) {
  for (const syn of synonyms) {
    SYNONYM_LOOKUP.set(syn.toLowerCase(), canonical2);
  }
}

// ../interego-native88/packages/pgsl/src/profiles.ts
var profileRegistry = /* @__PURE__ */ new Map();
function registerProfile(profile) {
  profileRegistry.set(profile.name, profile);
}
var rdfProfile = {
  name: "rdf",
  description: "RDF triple: subject/predicate/object structure",
  transform(input) {
    const triple = input;
    const localName = (uri2) => {
      const parts = uri2.split(/[#/]/).pop() ?? uri2;
      return parts.replace(/[-_]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
    };
    const s = localName(triple.subject).split(/\s+/).join(",");
    const p = localName(triple.predicate).split(/\s+/).join(",");
    const o = localName(triple.object).split(/\s+/).join(",");
    return `((${s}),(${p}),(${o}))`;
  }
};
var rawProfile = {
  name: "raw",
  description: "Raw text: flat word tokenization, no structural nesting",
  transform(input) {
    return String(input);
  }
};
registerProfile(rdfProfile);
registerProfile(rawProfile);

// ../interego-native88/packages/pgsl/src/agent-framework.ts
init_src();

// ../interego-native88/packages/pgsl/src/discovery.ts
init_src();
var DEFAULT_VIRTUAL_CONFIG = {
  maxCacheSize: 1024 * 1024,
  // 1 MB
  cacheEvictionPolicy: "lru",
  lazyLoadThreshold: 1024
  // 1 KB
};

// ../interego-native88/packages/pgsl/src/persistence.ts
init_src();

// ../interego-native88/packages/pgsl/src/projection.ts
init_src();

// ../interego-native88/packages/pgsl/src/virtualized-layer.ts
init_src();
init_src();

// ../interego-native88/packages/pgsl/src/interrogative-router.ts
init_src();

// ../interego-native88/applications/foxxi-content-intelligence/src/ns/rdf.ts
init_src();
var RDF4 = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
var RDFS3 = "http://www.w3.org/2000/01/rdf-schema#";
var OWL2 = "http://www.w3.org/2002/07/owl#";
var XSD5 = "http://www.w3.org/2001/XMLSchema#";
var SH = "http://www.w3.org/ns/shacl#";
var SKOS2 = "http://www.w3.org/2004/02/skos/core#";
var DCT2 = "http://purl.org/dc/terms/";
var PROV2 = "http://www.w3.org/ns/prov#";
var VANN = "http://purl.org/vocab/vann/";
var BIBO = "http://purl.org/ontology/bibo/";
var FOAF2 = "http://xmlns.com/foaf/0.1/";
var SCHEMA = "https://schema.org/";
var STD_PREFIXES = Object.freeze({
  rdf: RDF4,
  rdfs: RDFS3,
  owl: OWL2,
  xsd: XSD5,
  sh: SH,
  skos: SKOS2,
  dct: DCT2,
  prov: PROV2,
  vann: VANN,
  bibo: BIBO,
  foaf: FOAF2,
  schema: SCHEMA
});
function iri(value2) {
  if (turtleIriRef(value2) === null) throw new Error(`not an absolute, serializable IRI: ${JSON.stringify(value2)}`);
  return { termType: "NamedNode", value: value2 };
}
var RDF_TYPE4 = RDF4 + "type";
var RDF_FIRST3 = RDF4 + "first";
var RDF_REST3 = RDF4 + "rest";
var RDF_NIL3 = RDF4 + "nil";
var ENGLISH_ANNOTATIONS = [
  RDFS3 + "label",
  RDFS3 + "comment",
  SKOS2 + "prefLabel",
  SKOS2 + "altLabel",
  SKOS2 + "definition",
  SKOS2 + "scopeNote",
  SKOS2 + "note",
  SKOS2 + "example",
  SKOS2 + "editorialNote",
  SKOS2 + "historyNote",
  DCT2 + "title",
  DCT2 + "description",
  DCT2 + "rights",
  DCT2 + "bibliographicCitation",
  SH + "message",
  SH + "name",
  SH + "description"
];

// ../interego-native88/applications/foxxi-content-intelligence/src/ns/catalog.ts
var NS_BASE = "https://foxxi-bridge.interego.xwisee.com/ns/";
var FOXXI_MODULES = [
  "xapi",
  "scorm-cam",
  "scorm-sn",
  "scorm-rte",
  "cmi5",
  "ai-elearning",
  "soc2",
  "eu-ai-act",
  "nist-rmf",
  "ob3",
  "clr",
  "ieee-ler",
  "adl-tla",
  "foxxi"
];
function foxxiPrefix(module) {
  return module === "foxxi" ? "foxxi" : `foxxi-${module}`;
}
var FOXXI_PREFIXES = Object.freeze(
  Object.fromEntries(FOXXI_MODULES.map((m) => [foxxiPrefix(m), `${NS_BASE}${m}#`]))
);
var EXTERNAL_PREFIXES = Object.freeze({
  xapi: "https://w3id.org/xapi/ontology#",
  // ADL's xAPI ontology
  iep: "https://markjspivey-xwisee.github.io/interego/ns/iep#",
  pgsl: "https://markjspivey-xwisee.github.io/interego/ns/pgsl#",
  amta: "https://markjspivey-xwisee.github.io/interego/ns/amta#",
  hela: "https://markjspivey-xwisee.github.io/interego/ns/hela#",
  // The Interego substrate's own L3 compliance vocabularies, which the Foxxi foxxi-soc2,
  // foxxi-eu-ai-act and foxxi-nist-rmf documents map to.
  soc2: "https://markjspivey-xwisee.github.io/interego/ns/soc2#",
  "eu-ai-act": "https://markjspivey-xwisee.github.io/interego/ns/eu-ai-act#",
  "nist-rmf": "https://markjspivey-xwisee.github.io/interego/ns/nist-rmf#",
  vc: "https://www.w3.org/2018/credentials#",
  // 1EdTech's own Open Badges 3.0 and CLR 2.0 vocabularies (what their JSON-LD contexts map to).
  ob: "https://purl.imsglobal.org/spec/vc/ob/vocab.html#",
  clr: "https://purl.imsglobal.org/spec/vc/clr/vocab.html#",
  sec: "https://w3id.org/security#",
  prof: "http://www.w3.org/ns/dx/prof/",
  role: "http://www.w3.org/ns/dx/prof/role/",
  dcat: "http://www.w3.org/ns/dcat#"
});
var ALL_PREFIXES = Object.freeze({ ...STD_PREFIXES, ...EXTERNAL_PREFIXES, ...FOXXI_PREFIXES });
var STATUS_PUBLISHED = `${BIBO}status/published`;
var releaseTag = (version) => `foxxi-ns-${version}`;
var sourceAt = (version, path) => `https://github.com/markjspivey-xwisee/interego/blob/${releaseTag(version)}/${path}`;
var ANNOTATION = /* @__PURE__ */ new Set([
  ...[
    "title",
    "description",
    "creator",
    "contributor",
    "publisher",
    "license",
    "rights",
    "created",
    "modified",
    "issued",
    "language",
    "bibliographicCitation",
    "source",
    "conformsTo",
    "subject",
    "identifier",
    "references"
  ].map((x) => DCT2 + x),
  VANN + "preferredNamespacePrefix",
  VANN + "preferredNamespaceUri",
  BIBO + "status",
  ...[
    "prefLabel",
    "altLabel",
    "hiddenLabel",
    "definition",
    "note",
    "scopeNote",
    "example",
    "editorialNote",
    "historyNote",
    "changeNote",
    "notation",
    "exactMatch",
    "closeMatch",
    "broadMatch",
    "narrowMatch",
    "relatedMatch"
  ].map((x) => SKOS2 + x),
  SCHEMA + "keywords",
  "http://www.w3.org/ns/dcat#keyword"
]);
var OBJECT = /* @__PURE__ */ new Set([
  ...[
    "inScheme",
    "hasTopConcept",
    "topConceptOf",
    "member",
    "broader",
    "narrower",
    "related",
    "broaderTransitive",
    "narrowerTransitive",
    "semanticRelation"
  ].map((x) => SKOS2 + x),
  ...["hadMember", "wasDerivedFrom", "wasAttributedTo", "wasGeneratedBy", "used", "wasAssociatedWith", "hadPrimarySource"].map((x) => PROV2 + x),
  "http://www.w3.org/ns/dx/prof/isProfileOf",
  "http://www.w3.org/ns/dx/prof/hasResource",
  "http://www.w3.org/ns/dx/prof/hasRole",
  "http://www.w3.org/ns/dx/prof/hasArtifact",
  "https://markjspivey-xwisee.github.io/interego/ns/iep#constructedFrom"
]);
var SKOS_DOC = "http://www.w3.org/2004/02/skos/core";
var PROV_DOC = "http://www.w3.org/ns/prov-o";
var PROF = "http://www.w3.org/ns/dx/prof/";
var SUBSTRATE_NS = "https://markjspivey-xwisee.github.io/interego/ns/";
var ADL_XAPI = "https://w3id.org/xapi/ontology#";
var EXTERNAL_TERM_INFO = Object.freeze({
  [SKOS2 + "Concept"]: { label: "Concept", comment: "An idea or notion; a unit of thought. (SKOS)", definedBy: SKOS_DOC },
  [SKOS2 + "ConceptScheme"]: { label: "Concept Scheme", comment: "A set of concepts, optionally including statements about semantic relationships between those concepts. (SKOS)", definedBy: SKOS_DOC, disjointWith: SKOS2 + "Concept" },
  [SKOS2 + "Collection"]: { label: "Collection", comment: "A meaningful collection of concepts. (SKOS)", definedBy: SKOS_DOC },
  [SKOS2 + "inScheme"]: { label: "is in scheme", comment: "Relates a resource (for example a concept) to a concept scheme in which it is included. (SKOS)", definedBy: SKOS_DOC, range: SKOS2 + "ConceptScheme" },
  [SKOS2 + "hasTopConcept"]: { label: "has top concept", comment: "Relates, by convention, a concept scheme to a concept which is topmost in the broader/narrower concept hierarchies for that scheme. (SKOS)", definedBy: SKOS_DOC, domain: SKOS2 + "ConceptScheme", range: SKOS2 + "Concept" },
  [SKOS2 + "topConceptOf"]: { label: "is top concept in scheme", comment: "Relates a concept to the concept scheme that it is a top level concept of. (SKOS)", definedBy: SKOS_DOC, subPropertyOf: SKOS2 + "inScheme", inverseOf: SKOS2 + "hasTopConcept" },
  [SKOS2 + "member"]: { label: "has member", comment: "Relates a collection to one of its members. (SKOS)", definedBy: SKOS_DOC, domain: SKOS2 + "Collection" },
  [PROV2 + "Entity"]: { label: "Entity", comment: "A physical, digital, conceptual, or other kind of thing with some fixed aspects. (PROV-O)", definedBy: PROV_DOC },
  [PROV2 + "Agent"]: { label: "Agent", comment: "Something that bears some form of responsibility for an activity taking place, for the existence of an entity, or for another agent's activity. (PROV-O)", definedBy: PROV_DOC },
  [PROV2 + "Organization"]: { label: "Organization", comment: "A social or legal institution such as a company or a society. (PROV-O)", definedBy: PROV_DOC, subClassOf: PROV2 + "Agent" },
  [PROV2 + "Collection"]: { label: "Collection", comment: "An entity that provides a structure to some constituents that must themselves be entities. (PROV-O)", definedBy: PROV_DOC, subClassOf: PROV2 + "Entity" },
  [PROV2 + "wasDerivedFrom"]: { label: "was derived from", comment: "A transformation of an entity into another, an update of an entity resulting in a new one, or the construction of a new entity based on a pre-existing one. (PROV-O)", definedBy: PROV_DOC, domain: PROV2 + "Entity", range: PROV2 + "Entity" },
  [PROV2 + "wasAttributedTo"]: { label: "was attributed to", comment: "The ascribing of an entity to an agent. (PROV-O)", definedBy: PROV_DOC, domain: PROV2 + "Entity", range: PROV2 + "Agent" },
  [PROV2 + "hadMember"]: { label: "had member", comment: "Relates a collection to an entity that belongs to it. (PROV-O)", definedBy: PROV_DOC, domain: PROV2 + "Collection", range: PROV2 + "Entity" },
  [PROF + "Profile"]: { label: "Profile", comment: "A specification that constrains, extends, combines, or provides guidance or explanation about the usage of other specifications. (PROF)", definedBy: "http://www.w3.org/ns/dx/prof", subClassOf: DCT2 + "Standard" },
  [PROF + "isProfileOf"]: { label: "is profile of", comment: "The specification for which this profile is defined. (PROF)", definedBy: "http://www.w3.org/ns/dx/prof", domain: PROF + "Profile", range: DCT2 + "Standard" },
  [DCT2 + "Standard"]: { label: "Standard", comment: "A reference point against which other things can be evaluated or compared. (DCMI Metadata Terms)", definedBy: "http://purl.org/dc/terms/" },
  ["https://www.w3.org/2018/credentials#VerifiableCredential"]: { label: "Verifiable credential", comment: "A tamper-evident credential whose authorship can be cryptographically verified. (W3C VC Data Model 2.0)", definedBy: "https://www.w3.org/2018/credentials#" },
  [ADL_XAPI + "Verb"]: { label: "Verb", comment: "The class used for a Verb object in xAPI. (ADL xAPI ontology)", definedBy: "https://w3id.org/xapi/ontology" },
  [ADL_XAPI + "ActivityType"]: { label: "Activity type", comment: "The class for an Activity Type in an xAPI vocabulary or profile. (ADL xAPI ontology)", definedBy: "https://w3id.org/xapi/ontology" },
  [ADL_XAPI + "ContextExtension"]: { label: "Context extension", comment: "The class used to classify a ContextExtension in xAPI. (ADL xAPI ontology)", definedBy: "https://w3id.org/xapi/ontology" },
  [`${SUBSTRATE_NS}amta#Attestation`]: { label: "AMTA Attestation", comment: "A multi-dimensional trust attestation by one agent (the attestor) about another agent or claim (the subject). (Interego AMTA)", definedBy: `${SUBSTRATE_NS}amta` },
  [`${SUBSTRATE_NS}iep#ContextDescriptor`]: { label: "Context Descriptor", comment: "A metadata envelope that annotates one or more RDF named graphs with typed context facets: provenance, temporal validity, semiotic frame, trust level and federation metadata. (Interego Protocol)", definedBy: `${SUBSTRATE_NS}iep` },
  [`${SUBSTRATE_NS}iep#ComposedDescriptor`]: { label: "Composed Descriptor", comment: "A context descriptor produced by applying a composition operator (union, intersection, restriction, override) to two or more source descriptors. (Interego Protocol)", definedBy: `${SUBSTRATE_NS}iep` },
  [`${SUBSTRATE_NS}iep#Affordance`]: { label: "Affordance", comment: "A capability that a pod or manifest supports, for HATEOAS-style agent discovery of what operations are available. (Interego Protocol)", definedBy: `${SUBSTRATE_NS}iep` },
  [`${SUBSTRATE_NS}iep#constructedFrom`]: { label: "constructed from", comment: "Declares that the subject class or property is constructed at runtime from the named Interego Protocol primitives. (Interego Protocol)", definedBy: `${SUBSTRATE_NS}iep` },
  [`${SUBSTRATE_NS}hela#Statement`]: { label: "HELA Statement", comment: "An xAPI-style (actor, verb, object) statement \u2014 the atomic unit of HELA's presheaf category. (Interego HELA)", definedBy: `${SUBSTRATE_NS}hela` },
  [`${SUBSTRATE_NS}pgsl#Atom`]: { label: "Atom", comment: "A leaf node of the PGSL lattice holding one primitive value, identified by its content. (Interego PGSL)", definedBy: `${SUBSTRATE_NS}pgsl` }
});
var CLASS_POSITIONS = /* @__PURE__ */ new Set([
  RDFS3 + "subClassOf",
  OWL2 + "equivalentClass",
  OWL2 + "disjointWith",
  RDFS3 + "domain",
  OWL2 + "someValuesFrom",
  OWL2 + "allValuesFrom",
  OWL2 + "onClass",
  OWL2 + "complementOf"
]);

// ../interego-native88/applications/foxxi-content-intelligence/src/ns/html.ts
var SECTION_ORDER = [
  { id: "classes", title: "Classes", kind: "class", type: OWL2 + "Class" },
  { id: "object-properties", title: "Object properties", kind: "object property", type: OWL2 + "ObjectProperty" },
  { id: "datatype-properties", title: "Datatype properties", kind: "datatype property", type: OWL2 + "DatatypeProperty" },
  { id: "annotation-properties", title: "Annotation properties", kind: "annotation property", type: OWL2 + "AnnotationProperty" },
  { id: "datatypes", title: "Datatypes", kind: "datatype", type: RDFS3 + "Datatype" },
  { id: "concept-schemes", title: "Code lists (SKOS concept schemes)", kind: "code list", type: SKOS2 + "ConceptScheme" },
  { id: "collections", title: "Collections", kind: "collection", type: SKOS2 + "Collection" }
];

// ../interego-native88/applications/foxxi-content-intelligence/src/ns/sssom.ts
var BUILT_IN_PREFIXES = Object.freeze({
  owl: OWL2,
  rdf: RDF4,
  rdfs: RDFS3,
  skos: SKOS2,
  semapv: "https://w3id.org/semapv/vocab/",
  sssom: "https://w3id.org/sssom/"
});

// ../interego-native88/applications/foxxi-content-intelligence/src/ns/labels.ts
var ACRONYMS = {
  id: "ID",
  iri: "IRI",
  iris: "IRIs",
  uri: "URI",
  url: "URL",
  uuid: "UUID",
  lms: "LMS",
  sco: "SCO",
  au: "AU",
  ai: "AI",
  xapi: "xAPI",
  scorm: "SCORM",
  cmi: "CMI",
  adl: "ADL",
  ims: "IMS",
  lrs: "LRS",
  did: "DID",
  ui: "UI",
  json: "JSON",
  html: "HTML",
  sha1sum: "SHA-1 sum",
  sha2: "SHA-2",
  ifi: "IFI",
  idref: "IDREF",
  mbox: "mbox",
  openid: "OpenID",
  ref: "ref",
  xml: "XML",
  usd: "USD"
};
var WRITTEN_FORMS = new Set(Object.values(ACRONYMS));

// ../interego-native88/applications/foxxi-content-intelligence/src/foxxi-vocab.ts
var FOXXI_NS = "https://foxxi-bridge.interego.xwisee.com/ns/foxxi#";
var FOXXI_CONSTRUCTION = `${FOXXI_NS}construction`;
var COMPOSED_SPEC_ONTOLOGIES = ["xapi", "scorm-cam", "scorm-sn", "scorm-rte", "cmi5"].map((m) => FOXXI_NS.replace("foxxi#", m));
var FOXXI_VOCAB_DOC = FOXXI_NS.replace(/#$/, "");
var FOXXI_TERMS = [
  // ── Verbs ──────────────────────────────────────────────────────────
  { name: "verbs/scene-completed", kind: "Verb", label: "scene-completed", definition: "Every slide in a course scene has been viewed." },
  { name: "verbs/asked", kind: "Verb", label: "asked", definition: "A learner asked a content question to the concept-graph agentic retriever." },
  { name: "verbs/retrieved", kind: "Verb", label: "retrieved", definition: "Concept-graph retrieval traced a set of slides/concepts as evidence for an answer." },
  { name: "verbs/enrolled", kind: "Verb", label: "enrolled", definition: "A learner matched a tenant policy and was assigned a course." },
  { name: "verbs/credentialed", kind: "Verb", label: "credentialed", definition: "An Open Badges 3.0 / W3C VC credential was issued for the learner." },
  { name: "verbs/wallet-exported", kind: "Verb", label: "wallet-exported", definition: "A learner exported a CLR 2.0 envelope from their pod." },
  { name: "verbs/framework-aligned", kind: "Verb", label: "framework-aligned", definition: "An admin declared a CASE 1.0 cross-tenant alignment association." },
  { name: "verbs/policy-decided", kind: "Verb", label: "policy-decided", definition: "An ABAC policy returned an access decision (allow/deny) for a substrate call." },
  { name: "verbs/affordance-invoked", kind: "Verb", label: "affordance-invoked", definition: "A bridge affordance was called \u2014 the bridge instruments every handler with this verb." },
  { name: "performed", kind: "Verb", label: "performed", definition: "A unit of on-the-job production work was performed by a human or an AI agent (IEEE P2997 employment-history leg)." },
  // ── Structural (modal) verbs ───────────────────────────────────────
  // Domain-AGNOSTIC verbs naming the MODAL MODE of any agent's context-descriptor
  // act (iep:ModalStatusEnum), valid for ANY vertical — never a domain term. The
  // xAPI performance verb stays `performed` (above); these label the trajectory
  // step's mode so disposition reads the modal balance. (A Retracted descriptor
  // projects as the ADL core `voided` verb, not a foxxi term.)
  { name: "verbs/asserted", kind: "Verb", label: "asserted", definition: "An agent asserted a settled context descriptor (modal status Asserted; groundTruth true). The work was committed." },
  { name: "verbs/intended", kind: "Verb", label: "intended", definition: "An agent recorded a Hypothetical context descriptor \u2014 an intention / plan (groundTruth undefined). No completion is claimed." },
  { name: "verbs/considered", kind: "Verb", label: "considered", definition: "An agent recorded a Counterfactual (or Retracted) context descriptor \u2014 a road not taken / a withdrawn claim." },
  // ── Activity / descriptor types ────────────────────────────────────
  { name: "activities/scene", kind: "ActivityType", label: "scene", definition: "A course scene grouping multiple slides under a sub-theme." },
  { name: "activities/concept-graph-node", kind: "ActivityType", label: "concept-graph-node", definition: "A single concept in a course knowledge graph; carries prereq edges + slide membership." },
  { name: "activities/credential", kind: "ActivityType", label: "credential", definition: "A Verifiable Credential / Open Badge 3.0." },
  { name: "activities/framework", kind: "ActivityType", label: "framework", definition: "A CASE 1.0 / CaSS competency framework." },
  { name: "activities/affordance", kind: "ActivityType", label: "affordance", definition: "A bridge affordance / MCP tool, identified by toolName." },
  { name: "activities/fragment", kind: "ActivityType", label: "fragment", definition: "A piece of teaching or support whose IRI is the hash of its content: a concept, worked example, practice task, assessment item, job aid, reference, context, probe or reflection." },
  { name: "activities/composition", kind: "ActivityType", label: "composition", definition: "A path of positions holding fragments or compositions by reference, resolved per learner from their own record." },
  // Generic fallback activity type — names the ENVELOPE act (a context-descriptor
  // assertion) when the descriptor declares no conformsTo/facet type. The object
  // type of a projected statement is normally the descriptor's OWN conformsTo IRI
  // (e.g. ttt:Move, code:PullRequest, med:Diagnosis) passed through verbatim;
  // Foxxi never enumerates an application's types.
  { name: "AssertedContext", kind: "ActivityType", label: "Asserted Context", definition: "A context-descriptor assertion whose payload type the publisher did not declare \u2014 the domain-agnostic fallback object type for a projected performance statement." },
  // A second IRI for the same activity type as `activities/concept-graph-node` — the one every
  // emitter uses. Nothing emits this one; it stays resolvable for statements already recorded.
  { name: "conceptGraphNode", kind: "ActivityType", label: "concept graph node", definition: "Activity type for a concept-graph node referenced from an xAPI statement. Superseded by activities/concept-graph-node, which names the same thing and is the one Foxxi emits.", replacedBy: "activities/concept-graph-node" },
  { name: "ProductionTask", kind: "ActivityType", label: "Production Task", definition: "A unit of on-the-job production work \u2014 the object of a `performed` statement." },
  { name: "TrajectoryStep", kind: "Type", label: "Trajectory Step", definition: "One step of an agentic-native trajectory \u2014 a modal, poly-granular Context Descriptor." },
  { name: "CourseCompletionCredential", kind: "Type", label: "Course Completion Credential", definition: "A descriptor wrapping a W3C VC / Open Badges 3.0 course-completion credential in a learner pod wallet.", closeMatch: ["https://purl.imsglobal.org/spec/vc/ob/vocab.html#OpenBadgeCredential"] },
  { name: "CompetencyAssertion", kind: "Type", label: "Competency Assertion", definition: "A descriptor asserting a learner holds a competency.", closeMatch: ["https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#CompetencyAssertion"] },
  { name: "WalletEnvelope", kind: "Type", label: "Wallet Envelope", definition: "A CLR 2.0 wallet envelope aggregating verified credentials.", closeMatch: ["https://purl.imsglobal.org/spec/vc/clr/vocab.html#ClrCredential"] },
  { name: "CASEAlignment", kind: "Type", label: "CASE Alignment", definition: "A 1EdTech CASE 1.0 cross-framework alignment association descriptor." },
  { name: "TenantMetadata", kind: "Type", label: "Tenant Metadata", definition: "A descriptor carrying a Foxxi tenant's metadata." },
  { name: "AdaptiveSequencingPolicy", kind: "Type", label: "Adaptive Sequencing Policy", definition: "A descriptor declaring an adaptive content-sequencing policy." },
  { name: "PackageUpload", kind: "Type", label: "Package Upload", definition: "A descriptor recording that a SCORM / cmi5 package was uploaded. Hypothetical by construction: it records that bytes arrived, not what they contain." },
  { name: "ParsedPackage", kind: "Type", label: "Parsed Package", definition: "A descriptor carrying what a SCORM / cmi5 package actually IS \u2014 manifest identifier, course title, standard, authoring-tool fingerprint, SCO list and activity structure \u2014 read out of the uploaded zip in-process. Asserted, and it supersedes (iep:supersedes) the PackageUpload receipt for the same graph." },
  // Declared because foxxi.register_tutor_agent EMITS this type. Emitting an absolute
  // URL is only half a fix: without this entry GET /ns/foxxi/term/TutorAgentProfile
  // 404s (every projection — Turtle, JSON-LD, HTML table, term resource — is rendered
  // from FOXXI_TERMS), so the descriptor a caller publishes to their pod would name an
  // IRI that answers nothing.
  { name: "TutorAgentProfile", kind: "Type", label: "Tutor Agent Profile", definition: "A self-registered AI tutor agent's marketplace profile \u2014 DID, specialties (framework IRI + competency IRI + self-rated level) and contact endpoint. Self-asserted: foxxi.register_tutor_agent binds it to no signer, so what binds a profile to a tutor is publishing it to that tutor's own pod." },
  // ── Performance architecture ───────────────────────────────────────
  { name: "PerformanceSituation", kind: "Type", label: "Performance Situation", definition: "A typed, modal-statused descriptor of a performer (human or agent), the work, and observed performance. The unit the system reasons from \u2014 it carries no idealised future state; content is never assumed." },
  { name: "Diagnosis", kind: "Type", label: "Diagnosis", definition: "A contextualization of a performance situation: it reads the work regime and applies that regime\u2019s method \u2014 apply an established practice (Evident), a cause-factor gap analysis (Knowable), a dispositional read (Emergent), or stabilise first (Turbulent)." },
  { name: "InterventionPlan", kind: "Type", label: "Intervention Plan", definition: "The full paradigm of interventions for a contextualized situation \u2014 instruction, performance-support, reference, practice, assessment, coaching, probe, environmental-fix, no-intervention \u2014 each marked selected or ruled-out with its reasoning." },
  { name: "InterventionEvaluation", kind: "Type", label: "Intervention Evaluation", definition: "The Knowable regime\u2019s closing move: a four-level evaluation \u2014 response, capability, transfer, outcome \u2014 as a modal-status progression; a closed gap supersedes the prior observed-state (iep:supersedes)." },
  { name: "OutcomeRecord", kind: "Type", label: "Outcome Record", definition: "One distilled intervention outcome \u2014 in a regime, having named a cause and chosen an intervention, the verdict reached; and, if it missed, the cause re-contextualization found instead. The evidence atom of calibration." },
  { name: "CalibrationProfile", kind: "Type", label: "Calibration Profile", definition: "The system\u2019s recorded track record of its own Knowable-regime recommendations: per (regime \xD7 cause \xD7 intervention) cell, how often that recommendation actually closed the gap. A cell is Hypothetical until it has the samples to Assert a rate; profiles compose across organizations by union." },
  { name: "CapabilityTransfer", kind: "Type", label: "Capability Transfer", definition: "The performance reading of one agent teaching another. The unit taught is an ac:TeachingPackage (agent-collective); Foxxi frames a learner agent\u2019s acquisition of it as an A2A instruction intervention, verifies the transfer by reading the learner\u2019s own trajectories before and after, and emits an amta:Attestation that feeds ac:\u2019s modal discipline and the reflexive calibration loop. Foxxi composes the teaching foundation; it does not redefine it." },
  { name: "GroundingFragment", kind: "Type", label: "Grounding Fragment", definition: "A content-addressed atomic content unit (a PGSL atom) \u2014 the leaf of an emergent course; carries modality, cognitive level, provenance and disposition-suitability." },
  { name: "Lesson", kind: "Type", label: "Lesson", definition: "A syntagm of grounding fragments toward one competency-point; each position holds a paradigm of interchangeable alternatives.", subClassOf: ["Composition"] },
  { name: "Module", kind: "Type", label: "Module", definition: "A syntagm of lessons.", subClassOf: ["Composition"] },
  { name: "Course", kind: "Type", label: "Course", definition: "A syntagm of modules. Not a stored artifact \u2014 a composition recipe that personalises (restriction + override) into a different resolved course per performer.", subClassOf: ["Composition"] },
  { name: "Composition", kind: "Type", label: "Composition", definition: "One type for lesson, module, course and curriculum: a path of positions, each naming a competency and the fragments or compositions that can fill it, by reference. Its IRI is the hash of its content, and each learner gets it resolved from their own record." },
  { name: "ContentAdmission", kind: "Type", label: "Content Admission", definition: "What a learner keeps on their own pod about which forms of content suit them at a competency: the fragment kinds admitted and why, the plan or situation it came from and the regime that plan read, and when. The latest record for a competency stands, a withdrawal included; resolution reads it whenever a request names no admission of its own. The learner keeps it; the bridge only reads it." },
  { name: "AppliedVoid", kind: "Type", label: "Applied Void", definition: "That a statement in the record of a learner was voided, kept with that record by the bridge once the voiding took effect: the id of the voided statement and of the voiding one. The store of a lens is a view that eviction and restarts empty, while the copies of the voided statement in the lattice and on the pod of the learner outlive it; this record keeps them voided. Only a void that took effect is kept, never one a voiding statement merely names." },
  { name: "ContentBundle", kind: "Type", label: "Content Bundle", definition: "What an author made in one act, kept together on their pod: a root composition and every fragment and composition it holds, each still named by the hash of its own content and checked against it when read back. A folded course is kept as one bundle, so the pod takes one write rather than one per item." },
  { name: "Curriculum", kind: "Type", label: "Curriculum", definition: "A syntagm of courses toward a set of target competencies.", subClassOf: ["Composition"] },
  { name: "InFlowPerformanceSupport", kind: "Type", label: "In-Flow Performance Support", definition: "A job-aid fragment delivered by an affordance attached to the work context \u2014 surfaced when a performer enters the triggering task, not on a training schedule." },
  { name: "DeliveredContent", kind: "Type", label: "Delivered Content", definition: "A descriptor wrapping a unit of generated content delivered through a channel and published to the pod \u2014 so the delivery is itself a discoverable, federatable Context Descriptor, not a fire-and-forget send." },
  // ── Knowledge architecture ─────────────────────────────────────────
  { name: "WorkRegime", kind: "Type", label: "Work Regime", definition: "How knowable the relationship between act and outcome is for a piece of work \u2014 Evident, Knowable, Emergent, or Turbulent. The regime decides which consulting and knowledge method is valid." },
  { name: "ContentRevision", kind: "Type", label: "Content Revision", definition: "A revision of a judged content claim: the claim as it stood and the grade it had, the words now and the evidence cited from outside the passage, who revised it and whether as a person or an agent, and \u2014 once the revised claim is judged \u2014 the new judgment and the grade before and after. The original judgment stands; the revision names it." },
  { name: "AutonomyPolicy", kind: "Type", label: "Autonomy Policy", definition: "The constitutional policy that says when a judge may assert on a kind of question without a person: per kind, the registry rating on its axis the judge must reach, over how many outcomes the latest attestation must rest, and how many of those a person must have confirmed. Amended through propose, vote and ratify; each policy supersedes the last; a judgment cites the decision it was published under." },
  { name: "ContentJudgmentAttestation", kind: "Type", label: "Content Judgment Attestation", definition: "An attestation about the content-judging agent, in the AMTA axes (accuracy, competence, honesty, recency): the agent about itself, grounded in the calibration its confirmed outcomes give, or a learning engineer as a peer. The registry aggregates every one on the pod into the reputation foxxi.content_judgment_reputation serves.", subClassOf: ["https://markjspivey-xwisee.github.io/interego/ns/amta#Attestation"] },
  { name: "ContentJudgmentOutcome", kind: "Type", label: "Content Judgment Outcome", definition: "What a person held to be true about a content claim after a ContentJudgment: the confirmed answer, whether the model had it, and the Brier score of its probabilities. Asserted; it supersedes the judgment it scores, and the content judgment calibration is computed over these." },
  { name: "ContentJudgment", kind: "Type", label: "Content Judgment", definition: "A System One model judgment about a unit of course content \u2014 how well a claim is supported by its context and evidence (evidence-level), or which work regime the work it describes falls in (work-regime) \u2014 carried as typed probabilities with the model confidence. Hypothetical until a person confirms or refutes it; the descriptor controls say how." },
  { name: "CompetenceDecomposition", kind: "Type", label: "Competence Decomposition", definition: "A competency broken into knowledge components (recorded / trained / judged / lived / innate) by codifiability \u2014 how much of it can honestly become content." },
  { name: "KnowledgeAsset", kind: "Type", label: "Knowledge Asset", definition: "A unit of knowledge \u2014 a codified artefact, a narrative, or a connection to a holder; carries a codification level and, for codified assets, an explicit uncodified residue." },
  { name: "KnowledgeMap", kind: "Type", label: "Knowledge Map", definition: "A regime-routed knowledge strategy for a competency: what to codify into content and what to enable as a flow \u2014 connection, narrative, apprenticeship." },
  // ── Extensions / properties ────────────────────────────────────────
  { name: "slideId", kind: "Extension", label: "slideId", definition: "Identifier of the slide a statement is about." },
  { name: "sceneTitle", kind: "Extension", label: "sceneTitle", definition: "Title of the scene grouping." },
  { name: "conceptIds", kind: "Extension", label: "conceptIds", definition: "List of concept-graph node IDs referenced by the activity." },
  { name: "masteryThreshold", kind: "Extension", label: "masteryThreshold", definition: "cmi5 mastery threshold applied to score.scaled for the pass/fail decision (0.0\u20131.0)." },
  { name: "session", kind: "Extension", label: "session", definition: "Foxxi session UUID \u2014 joins all statements from a single learner launch." },
  { name: "affordanceTool", kind: "Extension", label: "affordanceTool", definition: "MCP tool name of the invoked affordance." },
  { name: "policyId", kind: "Extension", label: "policyId", definition: "ABAC policy descriptor IRI that produced a decision." },
  { name: "decision", kind: "Extension", label: "decision", definition: "ABAC decision \u2014 allow / deny." },
  { name: "callerRole", kind: "Extension", label: "callerRole", definition: "Resolved caller role at the time of an affordance call." },
  { name: "substrateDescriptorIri", kind: "Extension", label: "substrateDescriptorIri", definition: "IRI of the substrate context descriptor produced by an affordance call (xAPI \u2194 substrate cross-link)." },
  // Envelope-derived signals carried verbatim from the context-descriptor (never reinterpreted).
  { name: "supersededDescriptor", kind: "Extension", label: "supersededDescriptor", definition: "IRI of a prior descriptor this one revises/closes \u2014 the iep:supersedes link carried into xAPI as a structural revision signal (not a domain closure verb)." },
  { name: "trustLevel", kind: "Extension", label: "trustLevel", definition: "The descriptor's TrustFacet level (SelfAsserted / ThirdPartyAttested / CryptographicallyVerified), passed through verbatim." },
  { name: "judgmentKind", kind: "Extension", label: "judgmentKind", definition: "On a ContentJudgment: which question the model was asked \u2014 evidence-level (a Score over the evidence scale) or work-regime (a Choice among the four regimes)." },
  { name: "epistemicConfidence", kind: "Extension", label: "epistemicConfidence", definition: "The descriptor's SemioticFacet epistemic confidence [0.0\u20131.0] \u2014 confidence that the DESCRIPTOR itself is accurate (infrastructure-level), NOT a performance score. Carried as its own extension, never as result.score.scaled." },
  { name: "groundTruth", kind: "Extension", label: "groundTruth", definition: "The descriptor's tri-state groundTruth (true for Asserted, false for Counterfactual, undefined for Hypothetical), passed through verbatim." },
  { name: "endorsed", kind: "Extension", label: "endorsed", definition: "False when the descriptor is Quoted (recorded with no endorsement / source-attributed)." },
  { name: "observedBy", kind: "Extension", label: "observedBy", definition: "DID of the observer/evaluator who attested a performance record (provenance)." },
  { name: "costUsd", kind: "Extension", label: "costUsd", definition: "Cost of a performance execution in USD \u2014 agent performance economics." },
  { name: "contextKind", kind: "Extension", label: "contextKind", definition: "Whether a statement records `production` work, `training`, or `performance-support`." },
  { name: "workTrajectory", kind: "Extension", label: "workTrajectory", definition: "How a unit of recorded production work went, as its performer recorded it with the work: its steps, each with a modal status (done, intended, or considered and dropped), a granularity (task, subtask or tool call), what it acted on and its result. Carried in the performance statement itself, so it lives with the record on the performer's pod, and a work regime can be read from it later." },
  { name: "gradedTag", kind: "Extension", label: "gradedTag", definition: "HMAC the bridge puts on a result it graded itself, keyed by a secret only it holds; a credential earned from evidence counts only mastery statements that carry it, so a learner's own report is in the record but is not evidence." },
  { name: "deliveryChannel", kind: "Extension", label: "deliveryChannel", definition: "The channel a generated text artifact was delivered through \u2014 document, email, chat, or sms." },
  { name: "recipient", kind: "Extension", label: "recipient", definition: "The recipient address/handle a generated artifact was delivered to." },
  { name: "deliveredBody", kind: "Extension", label: "deliveredBody", definition: "Base64-encoded body text of a delivered-content artifact published to the pod." },
  { name: "deliveredVia", kind: "Extension", label: "deliveredVia", definition: "How a delivery left the bridge \u2014 a pod-descriptor publish, a channel webhook, or none (recorded only)." },
  { name: "contentForm", kind: "Extension", label: "contentForm", definition: "The text form a unit of content was rendered in \u2014 plain, markdown, html, or interactive (dynamic hypermedia)." },
  { name: "actorKind", kind: "Extension", label: "actorKind", definition: "Whether the actor is a `human` or an `agent`." },
  { name: "competency", kind: "Extension", label: "competency", definition: "The competency IRI the composition position a fragment filled develops." },
  { name: "compositionPosition", kind: "Extension", label: "compositionPosition", definition: "The index of the position, in the composition holding it, that a fragment filled." },
  { name: "alternativesOffered", kind: "Extension", label: "alternativesOffered", definition: "The fragment and composition IRIs a position offered, of which the fragment experienced was chosen." },
  { name: "chosenBecause", kind: "Extension", label: "chosenBecause", definition: "Why resolution chose the fragment for this learner, in words." },
  { name: "projectedFromTrajectoryStep", kind: "Extension", label: "projectedFromTrajectoryStep", definition: "IRI of the agentic-native trajectory step an xAPI statement was projected from." },
  { name: "bundleJson", kind: "Extension", label: "bundleJson", definition: "Base64-encoded JSON payload (e.g. a signed VC) embedded in a descriptor graph." },
  { name: "evaluationId", kind: "Extension", label: "evaluationId", definition: "IRI of the agent/harness evaluation cohort a `performed` run is bound to \u2014 ties an external-agent run to a head-to-head portfolio comparison." },
  { name: "candidateId", kind: "Extension", label: "candidateId", definition: "IRI of the evaluation candidate (one team's agent/harness) a run is attributed to within an evaluation cohort." },
  { name: "harness", kind: "Extension", label: "harness", definition: "The harness / runtime label an external agent is built on (name, version, runtime) \u2014 lets a portfolio read attribute behaviour to the harness." }
];
var TERM_INDEX = new Map(FOXXI_TERMS.map((t) => [t.name, t]));
var XAPI_ONT = "https://w3id.org/xapi/ontology#";
var KIND = {
  Verb: { xapiClass: `${XAPI_ONT}Verb`, scheme: { name: "VerbScheme", label: "Foxxi xAPI verbs", comment: "The xAPI verbs Foxxi statements use that no other authority defines. Each is also a Concept of the Foxxi xAPI Profile." } },
  ActivityType: { xapiClass: `${XAPI_ONT}ActivityType`, scheme: { name: "ActivityTypeScheme", label: "Foxxi xAPI activity types", comment: "The xAPI activity types Foxxi statements carry as object.definition.type." } },
  Extension: { xapiClass: `${XAPI_ONT}ContextExtension`, scheme: { name: "ExtensionScheme", label: "Foxxi xAPI context extensions", comment: "The keys Foxxi statements carry in context.extensions." } },
  Type: {}
};
var JSONLD_TERMS = {
  label: { "@id": RDFS3 + "label", "@language": "en" },
  comment: { "@id": RDFS3 + "comment", "@language": "en" },
  isDefinedBy: { "@id": RDFS3 + "isDefinedBy", "@type": "@id" }
};

// ../interego-native88/applications/foxxi-content-intelligence/src/turtle-escape.ts
init_src();

// ../interego-native88/applications/foxxi-content-intelligence/src/pod-statement-store.ts
var FOXXI = FOXXI_NS;
var FOXXI_STATEMENT_TYPE = `${FOXXI}LearningStatement`;
var FOXXI_VOIDED_BY = `${FOXXI}voidedBy`;
var FOXXI_BUNDLE_JSON = `${FOXXI}bundleJson`;

// ../interego-native88/applications/foxxi-content-intelligence/src/statement-store.ts
init_src();

// ../interego-native88/applications/foxxi-content-intelligence/src/native-lrs-store.ts
import { createHash as createHash5, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// ../interego-native88/applications/foxxi-content-intelligence/src/foundation-shared-lattice.ts
init_src();

// ../interego-native88/applications/foxxi-content-intelligence/src/foundation-holon-altitude.ts
init_src();

// ../interego-native88/applications/foxxi-content-intelligence/src/ssrf-guard.ts
init_src();

// ../interego-native88/applications/foxxi-content-intelligence/src/pgsl-ingestion-profiles.ts
var xapiProfile = {
  name: "xapi",
  description: "xAPI statement: short atom IDs with identity/name/result chains",
  // Legacy transform — kept for backward compatibility
  transform(input) {
    const stmt = input;
    const actorId = deriveActorId(stmt);
    const verbId = stmt.verb.id.split("/").pop() ?? "unknown";
    const objectId = stmt.object.id.split(/[/:]/).pop() ?? "unknown";
    const parts = [actorId, verbId, objectId];
    if (stmt.result) {
      const resultParts = [];
      if (stmt.result.score?.raw !== void 0) resultParts.push(`score:${stmt.result.score.raw}`);
      if (stmt.result.score?.max !== void 0) resultParts.push(`max:${stmt.result.score.max}`);
      if (stmt.result.success !== void 0) resultParts.push(`success:${stmt.result.success}`);
      if (stmt.result.duration) resultParts.push(`duration:${stmt.result.duration}`);
      if (resultParts.length > 0) parts.push(`(${resultParts.join(",")})`);
    }
    return `(${parts.join(",")})`;
  },
  transformMulti(input) {
    const stmt = input;
    const chains = [];
    const actorId = deriveActorId(stmt);
    const verbId = stmt.verb.id.split("/").pop() ?? "unknown";
    const objectId = stmt.object.id.split(/[/:]/).pop() ?? "unknown";
    chains.push(`${actorId} ${verbId} ${objectId}`);
    if (stmt.actor.account) {
      chains.push(`${actorId} identity ${stmt.actor.account.homePage}:${stmt.actor.account.name}`);
    } else if (stmt.actor.mbox) {
      chains.push(`${actorId} identity ${stmt.actor.mbox}`);
    } else if (stmt.actor.openid) {
      chains.push(`${actorId} identity ${stmt.actor.openid}`);
    }
    if (stmt.actor.name) {
      for (const part of stmt.actor.name.split(/\s+/)) {
        chains.push(`${actorId} name ${part}`);
      }
    }
    chains.push(`${verbId} identity ${stmt.verb.id}`);
    const verbDisplay = stmt.verb.display?.["en-US"];
    if (verbDisplay && verbDisplay !== verbId) {
      chains.push(`${verbId} display ${verbDisplay}`);
    }
    chains.push(`${objectId} identity ${stmt.object.id}`);
    const objName = stmt.object.definition?.name?.["en-US"];
    if (objName) {
      chains.push(`${objectId} name ${objName}`);
    }
    if (stmt.result) {
      if (stmt.result.score?.raw !== void 0) {
        chains.push(`${actorId} ${objectId} score ${stmt.result.score.raw}`);
      }
      if (stmt.result.score?.max !== void 0) {
        chains.push(`${actorId} ${objectId} max ${stmt.result.score.max}`);
      }
      if (stmt.result.score?.scaled !== void 0) {
        chains.push(`${actorId} ${objectId} scaled ${stmt.result.score.scaled}`);
      }
      if (stmt.result.success !== void 0) {
        chains.push(`${actorId} ${objectId} success ${stmt.result.success}`);
      }
      if (stmt.result.completion !== void 0) {
        chains.push(`${actorId} ${objectId} completion ${stmt.result.completion}`);
      }
      if (stmt.result.duration) {
        chains.push(`${actorId} ${objectId} duration ${stmt.result.duration}`);
      }
      if (stmt.result.response) {
        chains.push(`${actorId} ${objectId} response ${stmt.result.response}`);
      }
    }
    if (stmt.context?.platform) {
      chains.push(`${actorId} ${objectId} platform ${stmt.context.platform}`);
    }
    if (stmt.context?.instructor) {
      const instrId = stmt.context.instructor.mbox ? stmt.context.instructor.mbox : stmt.context.instructor.name ?? "unknown";
      chains.push(`${actorId} ${objectId} instructor ${instrId}`);
    }
    if (stmt.context?.registration) {
      chains.push(`${actorId} ${objectId} registration ${stmt.context.registration}`);
    }
    return chains;
  }
};
function deriveActorId(stmt) {
  if (stmt.actor.account) {
    return stmt.actor.account.name;
  } else if (stmt.actor.mbox) {
    return stmt.actor.mbox.replace("mailto:", "").split("@")[0];
  } else {
    return (stmt.actor.name ?? "unknown").toLowerCase().split(/\s+/).pop();
  }
}
var lersProfile = {
  name: "lers",
  description: "IEEE LERS (Learning & Employment Record): issuer/subject/achievement/evidence structure",
  transform(input) {
    const cred = input;
    const issuerPart = `(${cred.issuer.split(/[\s/:]+/).filter((s) => s.length > 1).join(",")})`;
    const subjectPart = `(${cred.subject.name.split(/\s+/).join(",")})`;
    const achieveParts = [cred.achievement.name];
    if (cred.achievement.level) achieveParts.push(cred.achievement.level);
    if (cred.achievement.framework) achieveParts.push(cred.achievement.framework);
    const achievePart = `(${achieveParts.join(",")})`;
    const parts = [issuerPart, subjectPart, achievePart];
    if (cred.evidence) {
      const evidenceParts = [];
      if (cred.evidence.statementCount !== void 0) evidenceParts.push(`${cred.evidence.statementCount} statements`);
      if (cred.evidence.averageScore !== void 0) evidenceParts.push(`avg ${cred.evidence.averageScore}`);
      if (evidenceParts.length > 0) {
        parts.push(`(${evidenceParts.join(",")})`);
      }
    }
    return `(${parts.join(",")})`;
  }
};
function registerFoxxiIngestionProfiles() {
  registerProfile(xapiProfile);
  registerProfile(lersProfile);
}

// ../interego-native88/applications/foxxi-content-intelligence/src/foundation-holon-altitude.ts
registerFoxxiIngestionProfiles();

// ../interego-native88/applications/foxxi-content-intelligence/src/foundation-shared-lattice.ts
var RETRY_BASE_MS = Number(process.env.FOXXI_LATTICE_RETRY_BASE_MS ?? 3e4);
var RETRY_MAX_MS = Number(process.env.FOXXI_LATTICE_RETRY_MAX_MS ?? 6e5);

// ../interego-native88/applications/foxxi-content-intelligence/src/spec-ontology.ts
var NS_ROOT = "https://foxxi-bridge.interego.xwisee.com/ns/";
var A = iri(RDF4 + "type");

// ../interego-native88/applications/foxxi-content-intelligence/src/spec/patterns.ts
var D = "[0-9]";
var NUM = `${D}+(\\.${D}+)?`;
var INT = `${D}+`;
var ISO_DATE_WHOLE = `(${INT}Y(${INT}M)?(${INT}D)?|${INT}M(${INT}D)?|${INT}D)`;
var ISO_DATE_LAST = `(${NUM}Y|${INT}Y${NUM}M|${INT}Y${INT}M${NUM}D|${INT}Y${NUM}D|${NUM}M|${INT}M${NUM}D|${NUM}D)`;
var ISO_TIME_LAST = `T(${NUM}H|${INT}H${NUM}M|${INT}H${INT}M${NUM}S|${INT}H${NUM}S|${NUM}M|${INT}M${NUM}S|${NUM}S)`;
var ISO8601_DURATION = `^P(${NUM}W|${ISO_DATE_LAST}|${ISO_DATE_WHOLE}${ISO_TIME_LAST}|${ISO_TIME_LAST})$`;
var XS_DATE = `(${D}+Y(${D}+M)?(${D}+D)?|${D}+M(${D}+D)?|${D}+D)`;
var XS_TIME = `T(${D}+H(${D}+M)?(${NUM}S)?|${D}+M(${NUM}S)?|${NUM}S)`;
var XS_DURATION = `^-?P(${XS_DATE}(${XS_TIME})?|${XS_TIME})$`;
var SECONDS_TO_HUNDREDTHS = `${D}+(\\.${D}{1,2})?`;
var TI_TIME = `T(${D}+H(${D}+M)?(${SECONDS_TO_HUNDREDTHS}S)?|${D}+M(${SECONDS_TO_HUNDREDTHS}S)?|${SECONDS_TO_HUNDREDTHS}S)`;
var SCORM_TIMEINTERVAL = `^P(${XS_DATE}(${TI_TIME})?|${TI_TIME})$`;
var TZD = `(Z|[+-]${D}{2}(:${D}{2})?)`;
var SCORM_TIME = `^${D}{4}(-${D}{2}(-${D}{2}(T${D}{2}(:${D}{2}(:${D}{2}(\\.${D}{1,2})?${TZD}?)?)?)?)?)?$`;
var RFC3339_TIMESTAMP = `^${D}{4}-${D}{2}-${D}{2}[Tt ]${D}{2}:${D}{2}(:${D}{2}(\\.${D}+)?)?(Z|[+-]${D}{2}:${D}{2})?$`;
var RFC3339_UTC_TIMESTAMP = `^${D}{4}-${D}{2}-${D}{2}T${D}{2}:${D}{2}:${D}{2}(\\.${D}+)?(Z|\\+00:00)$`;

// ../interego-native88/applications/foxxi-content-intelligence/src/spec/adl-xapi-ontology.ts
var ADL_XAPI_ONTOLOGY = "https://w3id.org/xapi/ontology";
var ADL_XAPI_NS = `${ADL_XAPI_ONTOLOGY}#`;
var ADL_XAPI_MODIFIED = "2017-08-11";
var ADL_XAPI_TERMS = Object.freeze({
  Account: "class",
  Activity: "class",
  ActivityDefinition: "class",
  ActivityExtension: "class",
  ActivityProfileResource: "class",
  ActivityType: "class",
  Actor: "class",
  Agent: "class",
  AgentProfileResource: "class",
  Attachments: "class",
  AttachmentUsageType: "class",
  Authority: "object",
  category: "object",
  choices: "object",
  completion: "datatype",
  contentType: "datatype",
  Context: "class",
  ContextActivities: "class",
  ContextExtension: "class",
  correctResponsesPattern: "datatype",
  description: "datatype",
  DescriptionPropertyUnion: "class",
  display: "datatype",
  DisplayPropertyUnion: "class",
  DocumentResource: "class",
  duration: "datatype",
  Extension: "class",
  extensions: "object",
  ExtensionsUnion: "class",
  fileURL: "datatype",
  Group: "class",
  grouping: "object",
  homePage: "datatype",
  id: "datatype",
  IDUnion: "class",
  InteractionComponent: "class",
  interactionId: "datatype",
  interactionType: "datatype",
  length: "datatype",
  mbox: "datatype",
  mbox_sha1sum: "datatype",
  member: "datatype",
  MemberUnion: "class",
  moreInfo: "object",
  name: "datatype",
  NamePropertyUnion: "class",
  Object: "class",
  objectType: "datatype",
  ObjectTypeUnion: "class",
  openid: "datatype",
  other: "object",
  parent: "object",
  registration: "datatype",
  response: "datatype",
  Result: "class",
  ResultExtension: "class",
  scale: "object",
  Score: "class",
  sha2: "datatype",
  source: "object",
  Statement: "class",
  StatementRef: "class",
  StateResource: "class",
  steps: "object",
  stored: "datatype",
  SubStatement: "class",
  success: "datatype",
  target: "object",
  timeStamp: "datatype",
  type: "object",
  usageType: "datatype",
  Verb: "class",
  version: "annotation"
});
var ADL_XAPI_LABEL_EXCEPTIONS = Object.freeze({
  ActivityDefinition: "Activity",
  DisplayPropertyUnion: "NamePropertyUnion",
  interactionId: "interactionID"
});
var SKOS_CONCEPT = "http://www.w3.org/2004/02/skos/core#Concept";
var XSD6 = "http://www.w3.org/2001/XMLSchema#";
var RDF_LANG_STRING = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";
var ADL_XAPI_SUBCLASS_OF = Object.freeze({
  Account: ["Actor"],
  Activity: [SKOS_CONCEPT, "Object"],
  ActivityDefinition: [SKOS_CONCEPT, "Activity"],
  ActivityExtension: ["Extension"],
  ActivityProfileResource: ["DocumentResource"],
  ActivityType: [SKOS_CONCEPT, "ActivityDefinition"],
  Actor: ["Statement"],
  Agent: ["Actor"],
  AgentProfileResource: ["DocumentResource"],
  AttachmentUsageType: [SKOS_CONCEPT, "Attachments"],
  Attachments: ["Statement"],
  Authority: ["Statement"],
  Context: ["Statement"],
  ContextActivities: ["Context"],
  ContextExtension: ["Extension"],
  DocumentResource: [SKOS_CONCEPT],
  Extension: [SKOS_CONCEPT],
  Group: ["Actor"],
  Object: ["Statement"],
  Result: ["Statement"],
  ResultExtension: ["Extension"],
  StateResource: ["DocumentResource"],
  StatementRef: ["Object"],
  SubStatement: ["Statement"],
  Verb: [SKOS_CONCEPT, "Statement"]
});
var ADL_XAPI_MISSPELLED_SUBCLASS_OF = Object.freeze({ Score: ["Result"] });
var ADL_XAPI_DISJOINT = Object.freeze([
  Object.freeze(["Actor", "Verb", "Object", "Context", "Result", "Authority", "Attachments"])
]);
var ADL_XAPI_UNIONS = Object.freeze({
  NamePropertyUnion: ["Actor", "Account", "Agent", "Group", "ActivityDefinition", "StatementRef"],
  DisplayPropertyUnion: ["Verb", "Attachments"],
  DescriptionPropertyUnion: ["Object", "ActivityDefinition", "InteractionComponent", "ContextActivities", "Attachments"],
  ExtensionsUnion: ["ActivityExtension", "ResultExtension", "ContextExtension"],
  MemberUnion: ["Agent", "Group", "Authority", "Attachments"],
  ObjectTypeUnion: ["Statement", "Actor", "Object", "Authority"],
  IDUnion: ["Statement", "StatementRef"]
});
var ADL_XAPI_DOMAIN = Object.freeze({
  category: ["ContextActivities"],
  choices: ["ActivityDefinition"],
  completion: ["Result"],
  contentType: ["Attachments"],
  correctResponsesPattern: ["ActivityDefinition"],
  description: ["DescriptionPropertyUnion"],
  display: ["DisplayPropertyUnion"],
  duration: ["Result"],
  extensions: ["ActivityDefinition", "ExtensionsUnion"],
  fileURL: ["Attachments"],
  grouping: ["ContextActivities"],
  homePage: ["Account"],
  id: ["IDUnion"],
  interactionId: ["InteractionComponent"],
  interactionType: ["ActivityDefinition"],
  length: ["Attachments"],
  mbox: ["Actor"],
  mbox_sha1sum: ["Actor"],
  member: ["MemberUnion"],
  moreInfo: ["ActivityDefinition"],
  name: ["ActivityDefinition", "NamePropertyUnion"],
  objectType: ["ObjectTypeUnion"],
  openid: ["Actor"],
  other: ["ContextActivities"],
  parent: ["ContextActivities"],
  registration: ["Context"],
  response: ["Result"],
  scale: ["ActivityDefinition"],
  sha2: ["Attachments"],
  source: ["ActivityDefinition"],
  steps: ["ActivityDefinition"],
  stored: ["Statement"],
  success: ["Result"],
  target: ["ActivityDefinition"],
  timeStamp: ["Statement"],
  type: ["ActivityDefinition"],
  usageType: ["Attachments"]
});
var ADL_XAPI_RANGE = Object.freeze({
  choices: ["InteractionComponent"],
  completion: [`${XSD6}boolean`],
  correctResponsesPattern: [`${XSD6}string`],
  description: [RDF_LANG_STRING],
  display: [RDF_LANG_STRING],
  duration: [`${XSD6}duration`],
  fileURL: [`${XSD6}string`],
  homePage: [`${XSD6}anyURI`],
  interactionId: [`${XSD6}string`],
  interactionType: [`${XSD6}string`],
  moreInfo: [`${XSD6}anyURI`],
  name: [RDF_LANG_STRING, `${XSD6}string`],
  objectType: [`${XSD6}string`],
  openid: [`${XSD6}anyURI`],
  response: [`${XSD6}string`],
  scale: ["InteractionComponent"],
  sha2: [`${XSD6}string`],
  source: ["InteractionComponent"],
  steps: ["InteractionComponent"],
  stored: [`${XSD6}dateTime`],
  success: [`${XSD6}boolean`],
  target: ["InteractionComponent"],
  timeStamp: [`${XSD6}dateTime`],
  type: ["ActivityType"],
  usageType: ["AttachmentUsageType"]
});

// ../interego-native88/applications/foxxi-content-intelligence/src/spec/xapi.model.ts
var XAPI_VERSION = "2026.10.1";
var XAPI_CONTEXT_URL = `${NS_ROOT}xapi/context/${XAPI_VERSION}`;
var XAPI_INTERACTION_TYPES = ["true-false", "choice", "fill-in", "long-fill-in", "matching", "performance", "sequencing", "likert", "numeric", "other"];
var XAPI_PATTERNS = { uuid: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", version: "^(1\\.0(\\.[0-9]+)?|2\\.0(\\.[0-9]+)?)$" };
var UUID = XAPI_PATTERNS.uuid;
var VERSION = XAPI_PATTERNS.version;
var TIMESTAMP = RFC3339_UTC_TIMESTAMP;
var DURATION = ISO8601_DURATION;
var SHA1_HEX = "^[0-9a-fA-F]{40}$";
var VOIDED = "http://adlnet.gov/expapi/verbs/voided";
var MEDIA_TYPE = "^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(\\s*;.*)?$";
var NUMBER = ["xsd:integer", "xsd:decimal", "xsd:double"];
var S = "IEEE 9274.1.1-2023";
var PARTS_UNDER = (adl, parts, here) => `Broader there: ADL's ontology places ${parts} under xapi:${adl} by rdfs:subClassOf, so its instances include them; here ${here}.`;
var XAPI_MODEL = {
  module: "xapi",
  title: "xAPI 2.0 (IEEE 9274.1.1-2023) \u2014 Statement data model",
  description: "An OWL 2 DL ontology and SHACL shapes for the Statement data model of xAPI 2.0, IEEE 9274.1.1-2023 (Content part, \xA75.2): Statement, Actor (Agent, Group, Account), Verb, Object (Activity, StatementRef, SubStatement), Result and Score, Context with its context activities, context agents and context groups, and Attachments, with the data types of \xA75.2.7. Each term is aligned to ADL's xAPI ontology by a SKOS mapping. A statement is read into the ontology through the JSON-LD 1.1 context published with it (/ns/xapi/context), and the shapes check that reading.",
  version: XAPI_VERSION,
  priorVersion: "2026.10.0",
  priorCompatibility: "backward",
  shapesPriorCompatibility: "incompatible",
  created: "2026-06-19",
  spec: "https://standards.ieee.org/ieee/9274.1.1/7321/",
  standards: [
    { title: "IEEE 9274.1.1-2023 \u2014 Standard for Learning Technology: JSON Data Model Format and RESTful Web Service for Learner Experience Data Tracking and Access (xAPI 2.0)", url: "https://standards.ieee.org/ieee/9274.1.1/7321/" },
    { title: "xAPI 2.0 base standard documentation (Content part), IEEE open source repository", url: "https://opensource.ieee.org/xapi/xapi-base-standard-documentation" }
  ],
  bodies: ["IEEE", "ADL"],
  // `adl-xapi:` is ADL's xAPI ontology. Inside this model a bare `xapi:` token would name THIS
  // module (the module name always resolves to its own namespace), so the alignment targets
  // need a prefix of their own; in the published documents they print as `xapi:`.
  prefixes: { "adl-xapi": "https://w3id.org/xapi/ontology#" },
  seeAlso: [ADL_XAPI_ONTOLOGY, XAPI_CONTEXT_URL],
  // Every term here is accounted for against ADL's ontology in the mapping set: mapped, or listed
  // as having no counterpart there.
  // ADL's ontology has no version IRI or versionInfo: its dcterms:modified stands for the version the
  // mappings are to, and what it declares at that version is recorded in adl-xapi-ontology.ts.
  counterpart: {
    iri: ADL_XAPI_ONTOLOGY,
    namespace: ADL_XAPI_NS,
    version: ADL_XAPI_MODIFIED,
    record: sourceAt(XAPI_VERSION, "applications/foxxi-content-intelligence/src/spec/adl-xapi-ontology.ts")
  },
  notes: [
    "Alignment to ADL's xAPI ontology (prefix xapi:) is by SKOS mappings chosen to hold when a tool reads them as OWL (skos:exactMatch as equivalence, skos:broadMatch as subsumption): skos:exactMatch where both name the same construct of the Statement data model and ADL's axioms for it agree with this ontology's; skos:broadMatch where ADL's class is broader, because its ontology places parts of the construct under it by rdfs:subClassOf (xapi:Statement, xapi:Actor, xapi:Activity, xapi:ActivityDefinition, xapi:Result, xapi:Context, xapi:Attachments); and skos:closeMatch where ADL declares a different kind of OWL entity (member, moreInfo, usageType, version) or gives axioms no use here could satisfy (Object, name, duration, fileURL, extensions). Each broadMatch and closeMatch carries its reason as an annotation on the mapping axiom. ADL's ontology is not imported, and none of its axioms is asserted here.",
    "The alignment is also published as an SSSOM 1.0 mapping set (/ns/xapi/mappings), which lists the terms with no counterpart in ADL's ontology as mappings to sssom:NoTermFound.",
    "Language maps (display, name, description) are rdf:langString values: one language-tagged string per entry of the map.",
    `A statement is read into this ontology through the JSON-LD 1.1 context at ${XAPI_CONTEXT_URL}: objectType is read as rdf:type, a Statement's and a Statement Reference's id as the xapi:id UUID, an Activity's and a Verb's id as the node's IRI. The shapes select what that reading produces \u2014 by class where xAPI types a node, and by the property that reaches it (sh:targetObjectsOf, sh:targetSubjectsOf) where xAPI leaves it untyped: a Statement, a Verb, a Result, a Context, an Agent whose objectType is left out.`
  ],
  classes: [
    {
      name: "Statement",
      label: "Statement",
      comment: "An immutable record that an Actor did something: the Actor, the Verb, the Object, and optionally a Result, a Context, a timestamp and Attachments.",
      source: `${S} \xA75.2.2`,
      broadMatch: ["adl-xapi:Statement"],
      mappingNotes: { "adl-xapi:Statement": PARTS_UNDER("Statement", "the parts of a Statement (Actor, Verb, Object, Context, Result, Authority, Attachments) and the Sub-Statement", "a Statement is the record alone, and disjoint from its parts") }
    },
    { name: "SubStatement", label: "Sub-Statement", comment: "A Statement nested as the Object of another Statement: an actor, verb and object (with optional result, context, timestamp and attachments), but no id, stored, version or authority, and never itself containing a Sub-Statement.", source: `${S} \xA75.2.2.3 (Object as Sub-Statement)`, subClassOf: ["Object"], exactMatch: ["adl-xapi:SubStatement"] },
    {
      name: "Actor",
      label: "Actor",
      comment: "Whom a Statement is about: an Agent or a Group, and never both.",
      source: `${S} \xA75.2.2.1`,
      disjointUnionOf: ["Agent", "Group"],
      hasKey: [["mbox"], ["mbox_sha1sum"], ["openid"], ["account"]],
      broadMatch: ["adl-xapi:Actor"],
      mappingNotes: { "adl-xapi:Actor": PARTS_UNDER("Actor", "Accounts (xapi:Account)", "an Account is not an Actor") }
    },
    { name: "Agent", label: "Agent", comment: "A single person or system, identified by exactly one Inverse Functional Identifier: mbox, mbox_sha1sum, openid or account.", source: `${S} \xA75.2.2.1 (Actor as Agent)`, subClassOf: ["Actor"], exactMatch: ["adl-xapi:Agent"] },
    { name: "Group", label: "Group", comment: "A collection of Agents. An Identified Group carries exactly one Inverse Functional Identifier and may list members; an Anonymous Group carries none and must list its members.", source: `${S} \xA75.2.2.1 (Actor as Anonymous Group; Actor as Identified Group)`, subClassOf: ["Actor"], exactMatch: ["adl-xapi:Group"] },
    { name: "Account", label: "Account", comment: "A user account on an existing system, such as an LMS or an intranet, identified by the system's home page and the account's name together.", source: `${S} \xA75.2.2.1 (Account)`, hasKey: [["homePage", "name"]], exactMatch: ["adl-xapi:Account"] },
    { name: "Verb", label: "Verb", comment: "The action of a Statement: an IRI that names the meaning (not the word), with a language map giving its display form.", source: `${S} \xA75.2.2.2`, exactMatch: ["adl-xapi:Verb"] },
    {
      name: "Object",
      label: "Object",
      comment: "What the Actor interacted with: an Activity, an Agent or Group, a Statement Reference, or a Sub-Statement \u2014 told apart by objectType.",
      source: `${S} \xA75.2.2.3`,
      unionOf: ["Activity", "Agent", "Group", "StatementRef", "SubStatement"],
      closeMatch: ["adl-xapi:Object"],
      mappingNotes: { "adl-xapi:Object": "Not an exact match: ADL's ontology makes xapi:Object disjoint from xapi:Actor (owl:AllDisjointClasses), so an Agent or Group is never an Object there, while xAPI 2.0 lets either be the Object of a Statement (\xA75.2.2.3) and here Object includes them; and it places Activity Definitions and activity types under xapi:Object, through xapi:Activity. Read as an equivalence, every Agent or Group here would be unsatisfiable." }
    },
    {
      name: "Activity",
      label: "Activity",
      comment: "A unit of instruction, experience or performance that is tracked, identified by an IRI.",
      source: `${S} \xA75.2.2.3 (Object as Activity)`,
      subClassOf: ["Object"],
      broadMatch: ["adl-xapi:Activity"],
      mappingNotes: { "adl-xapi:Activity": PARTS_UNDER("Activity", "Activity Definitions and activity types (xapi:ActivityDefinition, and under it xapi:ActivityType)", "an Activity's definition and its type are not Activities") }
    },
    {
      name: "ActivityDefinition",
      label: "Activity Definition",
      comment: "Metadata about an Activity: name, description, type, more information, interaction details and extensions.",
      source: `${S} \xA75.2.2.3 (Activity Definition)`,
      broadMatch: ["adl-xapi:ActivityDefinition"],
      mappingNotes: { "adl-xapi:ActivityDefinition": `${PARTS_UNDER("ActivityDefinition", "activity types (xapi:ActivityType)", "an activity type is not an Activity Definition")} ADL's ontology also labels the class Activity, the label of its Activity class; it is the Activity Definition.` }
    },
    { name: "InteractionComponent", label: "Interaction Component", comment: "One element of an interaction component list (a choice, a point on a scale, a source or target to match, or a step), with an id and an optional description.", source: `${S} \xA75.2.2.3 (Interaction Components)`, exactMatch: ["adl-xapi:InteractionComponent"] },
    { name: "StatementRef", label: "Statement Reference", comment: "A pointer to another Statement, by its UUID.", source: `${S} \xA75.2.2.3 (Object as Statement)`, subClassOf: ["Object"], exactMatch: ["adl-xapi:StatementRef"] },
    {
      name: "Result",
      label: "Result",
      comment: "A measured outcome of the experience a Statement records: score, success, completion, response, duration and extensions.",
      source: `${S} \xA75.2.2.4`,
      broadMatch: ["adl-xapi:Result"],
      mappingNotes: { "adl-xapi:Result": "Broader there: ADL's ontology places xapi:Score under xapi:Result \u2014 with rdfs:subClassof, a property RDFS does not define, so no tool reads the triple as an axiom; read as intended, a Result there includes its Score, and here a Score is not a Result. Mapped as broader so that the alignment holds when that triple is corrected." }
    },
    { name: "Score", label: "Score", comment: "The outcome of a graded Activity: a scaled score, and the raw score with its minimum and maximum.", source: `${S} \xA75.2.2.4 (Score)`, exactMatch: ["adl-xapi:Score"] },
    {
      name: "Context",
      label: "Context",
      comment: "Information that gives a Statement more meaning: its registration, context activities, context agents and groups, revision, platform, language, a related Statement and extensions.",
      source: `${S} \xA75.2.2.5`,
      broadMatch: ["adl-xapi:Context"],
      mappingNotes: { "adl-xapi:Context": PARTS_UNDER("Context", "context activities (xapi:ContextActivities)", "a Context's context activities are not a Context") }
    },
    { name: "ContextActivities", label: "Context Activities", comment: "The Activities a Statement is related to, by kind of relation: parent, grouping, category and other.", source: `${S} \xA75.2.2.5 (contextActivities)`, exactMatch: ["adl-xapi:ContextActivities"] },
    { name: "ContextAgent", label: "Context Agent", comment: "A relationship, limited to one Statement, between that Statement and one Agent, characterized by zero or more relevant types.", source: `${S} \xA75.2.2.5 (Context Agents)` },
    { name: "ContextGroup", label: "Context Group", comment: "A relationship, limited to one Statement, between that Statement and one Group, characterized by zero or more relevant types.", source: `${S} \xA75.2.2.5 (Context Groups)` },
    {
      name: "Attachment",
      label: "Attachment",
      comment: "A digital artifact logically part of a Statement \u2014 an essay, a video, a certificate image, or the JSON Web Signature of a signed Statement \u2014 described by its usage type, display name, content type, length and SHA-2 hash.",
      source: `${S} \xA75.2.2.6`,
      broadMatch: ["adl-xapi:Attachments"],
      mappingNotes: { "adl-xapi:Attachments": `${PARTS_UNDER("Attachments", "attachment usage types (xapi:AttachmentUsageType)", "an Attachment's usage type is not an Attachment")} ADL names the class in the plural, after the Statement's attachments property; its instances are the Attachment objects.` }
    },
    {
      name: "Extensions",
      label: "Extensions",
      comment: "An extensions map: a node whose properties are extension IRIs, each valued with any JSON value. The meaning and structure of a value are defined by whoever controls its IRI.",
      source: `${S} \xA75.2.7 (Extensions)`,
      relatedMatch: ["adl-xapi:Extension"],
      mappingNotes: { "adl-xapi:Extension": "Related, not the same: ADL's Extension classifies an extension's IRI (a SKOS concept, as an activity type is); this class is the map that carries extension values, keyed by those IRIs." }
    },
    { name: "ActivityType", label: "Activity Type", comment: "A kind of Activity, named by an IRI in an Activity Definition's type.", source: `${S} \xA75.2.2.3 (Activity Definition)`, subClassOf: ["skos:Concept"], exactMatch: ["adl-xapi:ActivityType"] },
    { name: "AttachmentUsageType", label: "Attachment Usage Type", comment: "A kind of use of an Attachment, named by an IRI coined for that use (for example a completion certificate, or a Statement signature).", source: `${S} \xA75.2.2.6`, subClassOf: ["skos:Concept"], exactMatch: ["adl-xapi:AttachmentUsageType"] }
  ],
  datatypes: [
    { name: "UUID", label: "UUID", comment: "A UUID in its standard string form (RFC 4122 / RFC 9562), hexadecimal digits in either case.", base: "xsd:string", pattern: UUID, source: `${S} \xA75.2.7 (UUIDs)` },
    { name: "Duration", label: "Duration", comment: "An ISO 8601:2004 duration in the format of its \xA74.4.3.2 (PnYnMnDTnHnMnS, weeks as PnW). The alternative format of \xA74.4.3.3 is not allowed. Defined on xsd:string because xsd:duration is outside the OWL 2 datatype map.", base: "xsd:string", pattern: DURATION, source: `${S} \xA75.2.7 (Duration)` },
    { name: "Version", label: "Version", comment: "An xAPI version in Semantic Versioning 1.0.0 form: 1.0.x or 2.0.x.", base: "xsd:string", pattern: VERSION, source: `${S} \xA75.2.2` },
    { name: "SHA1Hex", label: "SHA-1 hex", comment: "A hexadecimal SHA-1 digest (40 hex digits).", base: "xsd:string", pattern: SHA1_HEX, source: `${S} \xA75.2.2.1 (mbox_sha1sum)` },
    { name: "MediaType", label: "Internet media type", comment: "An Internet Media Type (RFC 6838), with optional parameters.", base: "xsd:string", pattern: MEDIA_TYPE, source: `${S} \xA75.2.2.6 (contentType)` },
    { name: "Number", label: "Number", comment: "A JSON number as RDF carries it: xsd:integer for an integer, xsd:double otherwise (JSON-LD 1.1 \xA78.6), or an xsd:decimal.", base: "xsd:decimal", alsoBases: ["xsd:double"], source: `${S} \xA75.2.2.4 (Score)` },
    { name: "ScaledScore", label: "Scaled score", comment: "A Number between -1 and 1, inclusive.", base: "xsd:decimal", alsoBases: ["xsd:double"], minInclusive: -1, maxInclusive: 1, source: `${S} \xA75.2.2.4 (Score: scaled)` }
  ],
  properties: [
    // Statement
    { name: "id", kind: "datatype", label: "id", comment: "A UUID: the identifier of a Statement, or of the Statement a Statement Reference points at.", domain: ["Statement", "StatementRef"], range: "UUID", functional: true, source: `${S} \xA75.2.2; \xA75.2.2.3 (Object as Statement)`, exactMatch: ["adl-xapi:id"] },
    { name: "actor", kind: "object", label: "actor", comment: "Whom the Statement is about, as an Agent or a Group.", domain: ["Statement", "SubStatement"], range: "Actor", functional: true, source: `${S} \xA75.2.2` },
    { name: "verb", kind: "object", label: "verb", comment: "The action taken by the Actor.", domain: ["Statement", "SubStatement"], range: "Verb", functional: true, source: `${S} \xA75.2.2` },
    { name: "object", kind: "object", label: "object", comment: "The Activity, Agent, Group or Statement that is the object of the Statement.", domain: ["Statement", "SubStatement"], range: "Object", functional: true, source: `${S} \xA75.2.2` },
    { name: "result", kind: "object", label: "result", comment: "The measured outcome of the experience.", domain: ["Statement", "SubStatement"], range: "Result", functional: true, source: `${S} \xA75.2.2` },
    { name: "context", kind: "object", label: "context", comment: "The context that gives the Statement more meaning.", domain: ["Statement", "SubStatement"], range: "Context", functional: true, source: `${S} \xA75.2.2` },
    { name: "timestamp", kind: "datatype", label: "timestamp", comment: "When the events the Statement describes occurred: an RFC 3339 timestamp in UTC, set by the LRS when not provided.", domain: ["Statement", "SubStatement"], range: "xsd:dateTime", functional: true, source: `${S} \xA75.2.2; \xA75.2.7 (Timestamps)`, exactMatch: ["adl-xapi:timeStamp"] },
    { name: "stored", kind: "datatype", label: "stored", comment: "When the LRS recorded the Statement. Set by the LRS.", domain: "Statement", range: "xsd:dateTime", functional: true, source: `${S} \xA75.2.2`, exactMatch: ["adl-xapi:stored"] },
    {
      name: "authority",
      kind: "object",
      label: "authority",
      comment: "The Agent or Group asserting that the Statement is true, verified by the LRS from authentication.",
      domain: "Statement",
      range: "Actor",
      functional: true,
      source: `${S} \xA75.2.2`,
      exactMatch: ["adl-xapi:Authority"],
      mappingNotes: { "adl-xapi:Authority": "ADL declares xapi:Authority an owl:ObjectProperty, as this is; its ontology also uses the IRI as a class (a subclass of xapi:Statement, and one of its disjoint classes)." }
    },
    {
      name: "version",
      kind: "datatype",
      label: "version",
      comment: "The xAPI version the Statement is associated with. Not recommended for a Learning Record Provider to set.",
      domain: "Statement",
      range: "Version",
      functional: true,
      source: `${S} \xA75.2.2`,
      closeMatch: ["adl-xapi:version"],
      mappingNotes: { "adl-xapi:version": "Not an exact match because of kind: ADL declares xapi:version an owl:AnnotationProperty, which no class axiom or shape can constrain; here it is a datatype property whose values are xAPI version numbers." }
    },
    { name: "attachments", kind: "object", label: "attachments", comment: "The headers of the Attachments to the Statement. xAPI calls the attachments an ordered array; in the JSON-LD reading of a statement they are a set, because an RDF list would take the reading out of OWL 2 DL, and xAPI matches an attachment to its part of a request, and a signature to its statement, by SHA-2 hash and usage type rather than by position. A consumer that needs the order reads it from the JSON.", domain: ["Statement", "SubStatement"], range: "Attachment", source: `${S} \xA75.2.2` },
    // Actor / Agent / Group / Account
    { name: "objectType", kind: "datatype", label: "object type", comment: "Which kind of object a node is. Required for a Group, a Statement Reference, a Sub-Statement, a context agent and a context group, and for an Agent used as a Statement's object. The JSON-LD reading of a statement (its context) reads objectType as rdf:type, the class this ontology names for the token, so this property does not occur there; it names the member for mappings (ADL's xapi:objectType) and for data that keeps the token as a string.", domain: ["Agent", "Group", "Activity", "StatementRef", "SubStatement", "ContextAgent", "ContextGroup"], oneOf: ["Agent", "Group", "Activity", "StatementRef", "SubStatement", "contextAgent", "contextGroup"], functional: true, source: `${S} \xA75.2.2.1; \xA75.2.2.3; \xA75.2.2.5`, notation: "objectType", exactMatch: ["adl-xapi:objectType"] },
    {
      name: "name",
      kind: "datatype",
      label: "name",
      comment: "A name: the full name of an Agent or Group, the unique id or login name of an Account, or the human-readable name of an Activity (a language map).",
      domain: ["Actor", "Account", "ActivityDefinition"],
      range: ["xsd:string", "rdf:langString"],
      source: `${S} \xA75.2.2.1; \xA75.2.2.3`,
      closeMatch: ["adl-xapi:name"],
      mappingNotes: { "adl-xapi:name": "Not an exact match: ADL's ontology gives xapi:name two ranges, rdf:langString and xsd:string, whose value spaces are disjoint, so no value is in both; and two domains, one of them xapi:ActivityDefinition, so whatever has a name would be an Activity Definition. Read as an equivalence, every name here \u2014 of an Agent, a Group, an Account or an Activity \u2014 would be inconsistent." }
    },
    { name: "mbox", kind: "datatype", label: "mbox", comment: 'A mailto IRI \u2014 "mailto:" followed by an email address uniquely assigned to the Agent or Group. An Inverse Functional Identifier.', domain: "Actor", range: "xsd:anyURI", functional: true, source: `${S} \xA75.2.2.1`, notation: "mbox", exactMatch: ["adl-xapi:mbox"], changeNote: "2026.10.0: its range is xsd:anyURI, since an mbox is a mailto IRI, and its domain is Actor, an Agent or a Group, as xAPI has it; they had been xsd:string and Agent." },
    { name: "mbox_sha1sum", kind: "datatype", label: "mbox SHA-1 sum", comment: "The hex-encoded SHA-1 hash of a mailto IRI (the value of an mbox). An Inverse Functional Identifier.", domain: "Actor", range: "SHA1Hex", functional: true, source: `${S} \xA75.2.2.1`, notation: "mbox_sha1sum", exactMatch: ["adl-xapi:mbox_sha1sum"], changeNote: "2026.10.0: its domain is Actor, an Agent or a Group, as xAPI has it; it had been Agent." },
    { name: "openid", kind: "datatype", label: "OpenID", comment: "An OpenID URI that uniquely identifies the Agent or Group. An Inverse Functional Identifier.", domain: "Actor", range: "xsd:anyURI", functional: true, source: `${S} \xA75.2.2.1`, exactMatch: ["adl-xapi:openid"], changeNote: "2026.10.0: its range is xsd:anyURI, since an OpenID is a URI, and its domain is Actor, an Agent or a Group, as xAPI has it; they had been xsd:string and Agent." },
    // An Inverse Functional Identifier, and an object property, so OWL 2 DL lets it say so: one
    // account node identifies one Actor, named or not (owl:hasKey, above, binds only named ones).
    { name: "account", kind: "object", label: "account", comment: "A user account on an existing system. An Inverse Functional Identifier.", domain: "Actor", range: "Account", functional: true, inverseFunctional: true, source: `${S} \xA75.2.2.1`, changeNote: "2026.10.0: its domain is Actor, an Agent or a Group, as xAPI has it; it had been Agent." },
    {
      name: "member",
      kind: "object",
      label: "member",
      comment: "An Agent that is a member of the Group (an unordered list).",
      domain: "Group",
      range: "Agent",
      source: `${S} \xA75.2.2.1`,
      closeMatch: ["adl-xapi:member"],
      mappingNotes: { "adl-xapi:member": "Not an exact match because of kind: ADL declares xapi:member an owl:DatatypeProperty, whose values are literals; a Group's members are Agents, individuals, so here it is an object property." }
    },
    { name: "homePage", kind: "datatype", label: "home page", comment: "The canonical home page of the system an Account is on (an IRL), after FOAF's accountServiceHomePage.", domain: "Account", range: "xsd:anyURI", functional: true, source: `${S} \xA75.2.2.1 (Account)`, closeMatch: ["http://xmlns.com/foaf/0.1/accountServiceHomepage"], exactMatch: ["adl-xapi:homePage"], changeNote: "2026.10.0: its range is xsd:anyURI, since a home page is an IRL; it had been xsd:string." },
    // Verb
    { name: "display", kind: "datatype", label: "display", comment: "The human-readable representation, in one or more languages, of a Verb (it does not change the Verb's meaning) or the display name of an Attachment.", domain: ["Verb", "Attachment"], range: "rdf:langString", source: `${S} \xA75.2.2.2; \xA75.2.2.6`, exactMatch: ["adl-xapi:display"] },
    // Activity / Activity Definition
    { name: "definition", kind: "object", label: "definition", comment: "The metadata of an Activity.", domain: "Activity", range: "ActivityDefinition", functional: true, source: `${S} \xA75.2.2.3 (Object as Activity)` },
    { name: "description", kind: "datatype", label: "description", comment: "A description, as a language map, of an Activity, an interaction component or an Attachment.", domain: ["ActivityDefinition", "InteractionComponent", "Attachment"], range: "rdf:langString", source: `${S} \xA75.2.2.3; \xA75.2.2.6`, exactMatch: ["adl-xapi:description"] },
    { name: "type", kind: "object", label: "type", comment: "The type of the Activity, an IRI.", domain: "ActivityDefinition", range: "ActivityType", functional: true, source: `${S} \xA75.2.2.3 (Activity Definition)`, exactMatch: ["adl-xapi:type"], changeNote: "2026.10.0: an object property, whose value is the activity type itself; before it, the unversioned publication made it a datatype property whose value was the type's IRI, an xsd:anyURI literal." },
    {
      name: "moreInfo",
      kind: "datatype",
      label: "more info",
      comment: "An IRL resolving to a document with human-readable information about the Activity, which may include a way to launch it.",
      domain: "ActivityDefinition",
      range: "xsd:anyURI",
      functional: true,
      source: `${S} \xA75.2.2.3 (Activity Definition)`,
      closeMatch: ["adl-xapi:moreInfo"],
      mappingNotes: { "adl-xapi:moreInfo": "Not an exact match because of kind: ADL declares xapi:moreInfo an owl:ObjectProperty with the datatype range xsd:anyURI, which OWL 2 DL does not allow; the value is an IRL, a literal, so here it is a datatype property." }
    },
    { name: "interactionType", kind: "datatype", label: "interaction type", comment: "The type of interaction, from the controlled vocabulary of interaction types.", domain: "ActivityDefinition", oneOf: [...XAPI_INTERACTION_TYPES], functional: true, source: `${S} \xA75.2.2.3 (Interaction Activities)`, exactMatch: ["adl-xapi:interactionType"] },
    { name: "correctResponsesPattern", kind: "datatype", label: "correct responses pattern", comment: "A pattern a learner's response is correct if it matches; a response is correct if it matches any pattern in the list. The structure depends on the interaction type.", domain: "ActivityDefinition", range: "xsd:string", source: `${S} \xA75.2.2.3 (Interaction Activities)`, exactMatch: ["adl-xapi:correctResponsesPattern"] },
    { name: "choices", kind: "object", label: "choices", comment: "The options available for selection or ordering in a choice or sequencing interaction.", domain: "ActivityDefinition", range: "InteractionComponent", source: `${S} \xA75.2.2.3 (Interaction Components)`, exactMatch: ["adl-xapi:choices"] },
    { name: "scale", kind: "object", label: "scale", comment: "The options on the scale of a likert interaction.", domain: "ActivityDefinition", range: "InteractionComponent", source: `${S} \xA75.2.2.3 (Interaction Components)`, exactMatch: ["adl-xapi:scale"] },
    { name: "source", kind: "object", label: "source", comment: "The sources to be matched in a matching interaction.", domain: "ActivityDefinition", range: "InteractionComponent", source: `${S} \xA75.2.2.3 (Interaction Components)`, exactMatch: ["adl-xapi:source"] },
    { name: "target", kind: "object", label: "target", comment: "The targets to be matched in a matching interaction.", domain: "ActivityDefinition", range: "InteractionComponent", source: `${S} \xA75.2.2.3 (Interaction Components)`, exactMatch: ["adl-xapi:target"] },
    { name: "steps", kind: "object", label: "steps", comment: "The elements making up a performance interaction.", domain: "ActivityDefinition", range: "InteractionComponent", source: `${S} \xA75.2.2.3 (Interaction Components)`, exactMatch: ["adl-xapi:steps"] },
    { name: "componentId", kind: "datatype", label: "component id", comment: `The id of an interaction component, unique within its list. (In JSON, the component's "id".)`, domain: "InteractionComponent", range: "xsd:string", functional: true, source: `${S} \xA75.2.2.3 (Interaction Components)`, notation: "id", exactMatch: ["adl-xapi:interactionId"] },
    // Result / Score
    { name: "score", kind: "object", label: "score", comment: "The score of the Agent in relation to the success or quality of the experience.", domain: "Result", range: "Score", functional: true, source: `${S} \xA75.2.2.4` },
    { name: "success", kind: "datatype", label: "success", comment: "Whether the attempt on the Activity was successful.", domain: "Result", range: "xsd:boolean", functional: true, source: `${S} \xA75.2.2.4`, exactMatch: ["adl-xapi:success"] },
    { name: "completion", kind: "datatype", label: "completion", comment: "Whether the Activity was completed.", domain: "Result", range: "xsd:boolean", functional: true, source: `${S} \xA75.2.2.4`, exactMatch: ["adl-xapi:completion"] },
    { name: "response", kind: "datatype", label: "response", comment: "A response, formatted for the given Activity.", domain: "Result", range: "xsd:string", functional: true, source: `${S} \xA75.2.2.4`, exactMatch: ["adl-xapi:response"] },
    {
      name: "duration",
      kind: "datatype",
      label: "duration",
      comment: "The period of time over which the Statement occurred.",
      domain: "Result",
      range: "Duration",
      functional: true,
      source: `${S} \xA75.2.2.4; \xA75.2.7 (Duration)`,
      closeMatch: ["adl-xapi:duration"],
      mappingNotes: { "adl-xapi:duration": "Not an exact match: ADL's ontology gives xapi:duration the range xsd:duration, which is outside the OWL 2 datatype map, whose values are not strings, and whose lexical space has no weeks (PnW), which xAPI allows; here a duration is the ISO 8601 string the standard prescribes. Read as an equivalence, every duration here would be inconsistent." },
      changeNote: "2026.10.0: its range is Duration, ISO 8601's duration format as xAPI restricts it, a pattern on xsd:string; it had been xsd:duration, which is outside the OWL 2 datatype map."
    },
    { name: "scaled", kind: "datatype", label: "scaled", comment: "The score as modified by scaling or normalization, between -1 and 1 inclusive.", domain: "Score", range: "ScaledScore", functional: true, source: `${S} \xA75.2.2.4 (Score)` },
    { name: "raw", kind: "datatype", label: "raw", comment: "The score achieved, unmodified by scaling or normalization; between min and max (inclusive) when they are present.", domain: "Score", range: "Number", functional: true, source: `${S} \xA75.2.2.4 (Score)` },
    { name: "min", kind: "datatype", label: "min", comment: "The lowest possible score for the experience; less than max when it is present.", domain: "Score", range: "Number", functional: true, source: `${S} \xA75.2.2.4 (Score)` },
    { name: "max", kind: "datatype", label: "max", comment: "The highest possible score for the experience; greater than min when it is present.", domain: "Score", range: "Number", functional: true, source: `${S} \xA75.2.2.4 (Score)` },
    // Context
    { name: "registration", kind: "datatype", label: "registration", comment: "The UUID of the registration the Statement is associated with.", domain: "Context", range: "UUID", functional: true, source: `${S} \xA75.2.2.5`, exactMatch: ["adl-xapi:registration"] },
    { name: "instructor", kind: "object", label: "instructor", comment: "The instructor the Statement relates to, when not its Actor. Not recommended in xAPI 2.0, which supersedes it with contextAgents.", domain: "Context", range: "Actor", functional: true, source: `${S} \xA75.2.2.5` },
    { name: "team", kind: "object", label: "team", comment: "The team the Statement relates to, when not its Actor. Not recommended in xAPI 2.0, which supersedes it with contextGroups.", domain: "Context", range: "Group", functional: true, source: `${S} \xA75.2.2.5` },
    { name: "contextActivities", kind: "object", label: "context activities", comment: "The Activities the Statement is related to, by kind of relation.", domain: "Context", range: "ContextActivities", functional: true, source: `${S} \xA75.2.2.5` },
    { name: "contextAgents", kind: "object", label: "context agents", comment: "Statement-specific relationships between the Statement and Agents.", domain: "Context", range: "ContextAgent", source: `${S} \xA75.2.2.5 (Context Agents)` },
    { name: "contextGroups", kind: "object", label: "context groups", comment: "Statement-specific relationships between the Statement and Groups.", domain: "Context", range: "ContextGroup", source: `${S} \xA75.2.2.5 (Context Groups)` },
    { name: "revision", kind: "datatype", label: "revision", comment: "The revision of the learning activity associated with the Statement, in a free format.", domain: "Context", range: "xsd:string", functional: true, source: `${S} \xA75.2.2.5` },
    { name: "platform", kind: "datatype", label: "platform", comment: "The platform used in the experience.", domain: "Context", range: "xsd:string", functional: true, source: `${S} \xA75.2.2.5` },
    { name: "language", kind: "datatype", label: "language", comment: "The RFC 5646 code of the language the experience mainly occurred in.", domain: "Context", range: "xsd:language", functional: true, source: `${S} \xA75.2.2.5` },
    { name: "statement", kind: "object", label: "statement", comment: "Another Statement to be considered as context for this one.", domain: "Context", range: "StatementRef", functional: true, source: `${S} \xA75.2.2.5` },
    { name: "parent", kind: "object", label: "parent", comment: "An Activity that is a direct parent of the Activity of the Statement.", domain: "ContextActivities", range: "Activity", source: `${S} \xA75.2.2.5 (contextActivities)`, exactMatch: ["adl-xapi:parent"] },
    { name: "grouping", kind: "object", label: "grouping", comment: "An Activity with an indirect relation to the Activity of the Statement.", domain: "ContextActivities", range: "Activity", source: `${S} \xA75.2.2.5 (contextActivities)`, exactMatch: ["adl-xapi:grouping"] },
    { name: "category", kind: "object", label: "category", comment: "An Activity used to categorize the Statement \u2014 for example the xAPI Profile it conforms to.", domain: "ContextActivities", range: "Activity", source: `${S} \xA75.2.2.5 (contextActivities)`, exactMatch: ["adl-xapi:category"] },
    { name: "other", kind: "object", label: "other", comment: "An Activity related to the Statement in another way.", domain: "ContextActivities", range: "Activity", source: `${S} \xA75.2.2.5 (contextActivities)`, exactMatch: ["adl-xapi:other"] },
    { name: "agent", kind: "object", label: "agent", comment: "The one Agent a context agent relationship is defined for.", domain: "ContextAgent", range: "Agent", functional: true, source: `${S} \xA75.2.2.5 (Context Agents)` },
    { name: "group", kind: "object", label: "group", comment: "The one Group a context group relationship is defined for.", domain: "ContextGroup", range: "Group", functional: true, source: `${S} \xA75.2.2.5 (Context Groups)` },
    { name: "relevantTypes", kind: "object", label: "relevant types", comment: "A type IRI characterizing the relationship between the Statement and the Agent or Group. Without any, only a generic relationship is intended (not recommended).", domain: ["ContextAgent", "ContextGroup"], range: "skos:Concept", source: `${S} \xA75.2.2.5 (Context Agents; Context Groups)` },
    // Attachment
    {
      name: "usageType",
      kind: "object",
      label: "usage type",
      comment: "The usage of the Attachment, an IRI coined for that use.",
      domain: "Attachment",
      range: "AttachmentUsageType",
      functional: true,
      source: `${S} \xA75.2.2.6`,
      closeMatch: ["adl-xapi:usageType"],
      mappingNotes: { "adl-xapi:usageType": "Not an exact match because of kind: ADL declares xapi:usageType an owl:DatatypeProperty with the class range xapi:AttachmentUsageType, which OWL 2 DL does not allow; a usage type is an IRI naming a concept, so here it is an object property." },
      changeNote: "2026.10.0: an object property, whose value is the usage type itself; before it, the unversioned publication made it a datatype property whose value was the usage type's IRI, an xsd:anyURI literal."
    },
    { name: "contentType", kind: "datatype", label: "content type", comment: "The Internet Media Type of the Attachment.", domain: "Attachment", range: "MediaType", functional: true, source: `${S} \xA75.2.2.6`, exactMatch: ["adl-xapi:contentType"] },
    { name: "length", kind: "datatype", label: "length", comment: "The length of the Attachment data, in octets.", domain: "Attachment", range: "xsd:nonNegativeInteger", functional: true, source: `${S} \xA75.2.2.6`, exactMatch: ["adl-xapi:length"] },
    { name: "sha2", kind: "datatype", label: "SHA-2", comment: "The SHA-2 hash of the Attachment data; required even when fileUrl is given.", domain: "Attachment", range: "xsd:string", functional: true, source: `${S} \xA75.2.2.6`, exactMatch: ["adl-xapi:sha2"] },
    {
      name: "fileUrl",
      kind: "datatype",
      label: "file URL",
      comment: "An IRL from which the Attachment data can be, or could once be, retrieved.",
      domain: "Attachment",
      range: "xsd:anyURI",
      functional: true,
      source: `${S} \xA75.2.2.6`,
      closeMatch: ["adl-xapi:fileURL"],
      mappingNotes: { "adl-xapi:fileURL": "Not an exact match: ADL's ontology gives xapi:fileURL the range xsd:string, and here a file URL is an xsd:anyURI (an IRL); OWL 2 keeps the two value spaces apart, so read as an equivalence every file URL here would be inconsistent." }
    },
    // Extensions
    {
      name: "extensions",
      kind: "object",
      label: "extensions",
      comment: "A map of further properties keyed by IRI, on an Activity Definition, a Result or a Context.",
      domain: ["ActivityDefinition", "Result", "Context"],
      range: "Extensions",
      functional: true,
      source: `${S} \xA75.2.7 (Extensions)`,
      closeMatch: ["adl-xapi:extensions"],
      mappingNotes: { "adl-xapi:extensions": "Not an exact match: ADL's ontology gives xapi:extensions two domains, xapi:ActivityDefinition and the union of its extension concepts, so whatever has extensions would be an Activity Definition \u2014 and so an Activity and an Object, which a Result or a Context cannot be there; and its extensions point at extension concepts, where here they point at the map that carries the values. Read as an equivalence, every Result or Context with extensions would be inconsistent." },
      changeNote: "2026.10.0: its range is the class Extensions, a node whose properties are the extension IRIs; it had been rdf:JSON, a datatype, which an object property cannot have in OWL 2 DL."
    }
  ],
  vocabularies: [
    {
      name: "InteractionType",
      label: "Interaction types",
      comment: "The controlled vocabulary of interaction types for interaction Activities. Each value fixes the format of the correct responses pattern and the learner's response. xAPI takes the ten from the SCORM 2004 run-time data model (cmi.interactions.n.type), and each is an exact match of the one there.",
      members: [
        { name: "true-false", label: "true or false", comment: "An interaction with two possible responses: true or false.", exactMatch: ["foxxi-scorm-rte:InteractionType-true-false"] },
        { name: "choice", label: "choice", comment: "An interaction with a number of possible choices from which the learner selects one or several.", exactMatch: ["foxxi-scorm-rte:InteractionType-choice"] },
        { name: "fill-in", label: "fill in", comment: "An interaction requiring a short response of one or more strings of characters (normally 250 characters or fewer).", exactMatch: ["foxxi-scorm-rte:InteractionType-fill-in"] },
        { name: "long-fill-in", label: "long fill in", comment: "An interaction requiring a long response (normally more than 250 characters).", exactMatch: ["foxxi-scorm-rte:InteractionType-long-fill-in"] },
        { name: "matching", label: "matching", comment: "An interaction in which the learner matches items in a source set to items in a target set.", exactMatch: ["foxxi-scorm-rte:InteractionType-matching"] },
        { name: "performance", label: "performance", comment: "An interaction requiring the learner to perform a task of several steps.", exactMatch: ["foxxi-scorm-rte:InteractionType-performance"] },
        { name: "sequencing", label: "sequencing", comment: "An interaction in which the learner orders items in a set.", exactMatch: ["foxxi-scorm-rte:InteractionType-sequencing"] },
        { name: "likert", label: "Likert", comment: "An interaction in which the learner selects from a discrete set of choices on a scale.", exactMatch: ["foxxi-scorm-rte:InteractionType-likert"] },
        { name: "numeric", label: "numeric", comment: "An interaction requiring a numeric response.", exactMatch: ["foxxi-scorm-rte:InteractionType-numeric"] },
        { name: "other", label: "other", comment: "An interaction that fits none of the other types.", exactMatch: ["foxxi-scorm-rte:InteractionType-other"] }
      ]
    }
  ],
  disjoint: [
    // objectType is exclusive: one node is one kind of object.
    ["Activity", "Agent", "Group", "StatementRef", "SubStatement"],
    // A Statement is never the Object of a Statement — a Sub-Statement or a Statement Reference is.
    ["Statement", "Object"],
    // The parts of a Statement are different kinds of thing.
    ["Statement", "Verb", "Result", "Score", "Context", "ContextActivities", "ContextAgent", "ContextGroup", "Attachment", "Account", "ActivityDefinition", "InteractionComponent", "Extensions"]
  ],
  shapes: [
    {
      name: "StatementShape",
      targetClass: "Statement",
      targetSubjectsOf: ["actor", "verb", "object"],
      label: "xAPI Statement conformance",
      comment: `${S} \xA75.2.2: a Statement has exactly one actor, verb and object; its id (if present) is a UUID; its timestamps are RFC 3339 in UTC; its version follows the xAPI version grammar. Read through /ns/xapi/context a statement is untyped, as xAPI leaves it, so the shape also selects whatever has an actor, a verb or an object \u2014 a Statement, or a Sub-Statement, which the Sub-Statement shape further restricts.`,
      constraints: [
        { path: "actor", minCount: 1, maxCount: 1, comment: "exactly one Actor (\xA75.2.2)" },
        { path: "verb", minCount: 1, maxCount: 1, comment: "exactly one Verb (\xA75.2.2)" },
        { path: "object", minCount: 1, maxCount: 1, comment: "exactly one Object (\xA75.2.2)" },
        { path: "id", maxCount: 1, datatype: "xsd:string", pattern: UUID, comment: "a UUID (\xA75.2.2, \xA75.2.7)" },
        { path: "result", maxCount: 1, comment: "at most one Result (\xA75.2.2)" },
        { path: "context", maxCount: 1, comment: "at most one Context (\xA75.2.2)" },
        { path: "timestamp", maxCount: 1, datatype: "xsd:dateTime", pattern: TIMESTAMP, comment: "RFC 3339, in UTC (\xA75.2.7)" },
        { path: "stored", maxCount: 1, datatype: "xsd:dateTime", pattern: TIMESTAMP, comment: "RFC 3339, in UTC (\xA75.2.7)" },
        { path: "version", maxCount: 1, datatype: "xsd:string", pattern: VERSION, comment: "xAPI version grammar (\xA75.2.2)" },
        { path: "authority", maxCount: 1, comment: "one authority Actor (\xA75.2.2)" }
      ],
      atLeastOneOf: { alternatives: [{ shape: "NotVoidingShape" }, { shape: "VoidingShape" }], comment: "a voiding Statement's object is a Statement Reference (\xA75.2.5)" }
    },
    {
      name: "NotVoidingShape",
      label: "Not a voiding Statement",
      comment: `${S} \xA75.2.5: a Statement whose verb is not voided. Referred to by the Statement shape; it selects nothing itself.`,
      constraints: [
        { path: "verb.id", rdfPath: "verb", notHasValue: VOIDED, notHasIri: VOIDED, comment: "the verb is not voided" }
      ]
    },
    {
      name: "VoidingShape",
      label: "Voiding Statement",
      comment: `${S} \xA75.2.5: a Statement that voids another names it by a Statement Reference. Referred to by the Statement shape; it selects nothing itself.`,
      constraints: [
        { path: "object.objectType", rdfPath: ["object", "rdf:type"], hasValue: "StatementRef", hasIri: "StatementRef", comment: "the object is a Statement Reference (\xA75.2.5)" }
      ]
    },
    {
      name: "ActorShape",
      targetObjectsOf: ["actor", "authority", "instructor"],
      label: "Actor conformance",
      comment: `${S} \xA75.2.2.1: an Actor is a Group \u2014 which says so (objectType Group) \u2014 or else an Agent; read through /ns/xapi/context an Agent whose objectType is left out is untyped, so this shape holds whatever is an actor, an authority or an instructor to the Agent shape unless it is a Group.`,
      constraints: [],
      atLeastOneOf: { alternatives: [{ class: "Group" }, { shape: "AgentShape" }], comment: "a Group, or an Agent (\xA75.2.2.1)" }
    },
    {
      name: "AgentShape",
      targetClass: "Agent",
      targetObjectsOf: ["member", "agent"],
      label: "Agent conformance",
      comment: `${S} \xA75.2.2.1: an Agent is identified by EXACTLY ONE Inverse Functional Identifier (mbox / mbox_sha1sum / openid / account) \u2014 rendered as sh:xone below and enforced by the validator.`,
      constraints: [
        { path: "objectType", rdfPath: null, maxCount: 1, in: ["Agent"], comment: "Agent, when present (\xA75.2.2.1); read as rdf:type" },
        { path: "mbox", maxCount: 1, datatype: "xsd:anyURI", pattern: "^mailto:", comment: "a mailto IRI (\xA75.2.2.1)" },
        { path: "mbox_sha1sum", maxCount: 1, datatype: "xsd:string", pattern: SHA1_HEX, comment: "hex SHA-1 (\xA75.2.2.1)" },
        { path: "openid", maxCount: 1, datatype: "xsd:anyURI", comment: "an OpenID URI (\xA75.2.2.1)" },
        { path: "account", maxCount: 1, comment: "one account (\xA75.2.2.1)" }
      ],
      exactlyOneOf: { paths: ["mbox", "mbox_sha1sum", "openid", "account"], comment: "exactly one IFI (\xA75.2.2.1)" }
    },
    {
      name: "GroupShape",
      targetClass: "Group",
      label: "Group conformance",
      comment: `${S} \xA75.2.2.1: a Group is an Identified Group, with exactly one IFI (and members if it lists them), or an Anonymous Group, with members and no IFI.`,
      constraints: [
        { path: "objectType", rdfPath: null, minCount: 1, maxCount: 1, in: ["Group"], comment: "Group (\xA75.2.2.1); read as rdf:type" },
        { path: "mbox", maxCount: 1, datatype: "xsd:anyURI", pattern: "^mailto:", comment: "a mailto IRI (\xA75.2.2.1)" },
        { path: "mbox_sha1sum", maxCount: 1, datatype: "xsd:string", pattern: SHA1_HEX, comment: "hex SHA-1 (\xA75.2.2.1)" }
      ],
      atLeastOneOf: { alternatives: [{ shape: "IdentifiedGroupShape" }, { shape: "AnonymousGroupShape" }], comment: "an Identified Group or an Anonymous Group (\xA75.2.2.1)" }
    },
    {
      name: "IdentifiedGroupShape",
      label: "Identified Group",
      comment: `${S} \xA75.2.2.1 (Actor as Identified Group): exactly one Inverse Functional Identifier. Referred to by the Group shape; it selects nothing itself.`,
      constraints: [],
      exactlyOneOf: { paths: ["mbox", "mbox_sha1sum", "openid", "account"], comment: "exactly one IFI (\xA75.2.2.1)" }
    },
    {
      name: "AnonymousGroupShape",
      label: "Anonymous Group",
      comment: `${S} \xA75.2.2.1 (Actor as Anonymous Group): a member list, and no Inverse Functional Identifier. Referred to by the Group shape; it selects nothing itself.`,
      constraints: [
        { path: "member", minCount: 1, comment: "the Agents in the Group (\xA75.2.2.1)" },
        { path: "mbox", maxCount: 0 },
        { path: "mbox_sha1sum", maxCount: 0 },
        { path: "openid", maxCount: 0 },
        { path: "account", maxCount: 0 }
      ]
    },
    {
      name: "AccountShape",
      targetClass: "Account",
      targetObjectsOf: ["account"],
      label: "Account conformance",
      comment: `${S} \xA75.2.2.1: an Account has exactly one homePage (an IRL) and exactly one name.`,
      constraints: [
        { path: "homePage", minCount: 1, maxCount: 1, datatype: "xsd:anyURI", comment: "the system home page (\xA75.2.2.1)" },
        { path: "name", minCount: 1, maxCount: 1, datatype: "xsd:string", comment: "the account name (\xA75.2.2.1)" }
      ]
    },
    {
      name: "VerbShape",
      targetClass: "Verb",
      targetObjectsOf: ["verb"],
      label: "Verb conformance",
      comment: `${S} \xA75.2.2.2: a Verb is identified by an IRI; its display is a language map.`,
      constraints: [
        { path: "id", identifies: true, minCount: 1, maxCount: 1, nodeKind: "IRI", comment: "the Verb IRI (\xA75.2.2.2)" },
        { path: "display", datatype: "rdf:langString", comment: "a language map (\xA75.2.2.2)" }
      ]
    },
    {
      name: "ObjectShape",
      targetObjectsOf: ["object"],
      label: "Object conformance",
      comment: `${S} \xA75.2.2.3: the Object of a Statement is an Agent, a Group, a Statement Reference or a Sub-Statement \u2014 each of which says so (objectType) \u2014 or else an Activity.`,
      constraints: [],
      atLeastOneOf: {
        alternatives: [{ class: "Agent" }, { class: "Group" }, { class: "StatementRef" }, { class: "SubStatement" }, { shape: "ActivityShape" }],
        comment: "an Agent, a Group, a Statement Reference or a Sub-Statement, or else an Activity (\xA75.2.2.3)"
      }
    },
    {
      name: "ActivityShape",
      targetClass: "Activity",
      targetObjectsOf: ["parent", "grouping", "category", "other"],
      label: "Activity conformance",
      comment: `${S} \xA75.2.2.3: an Activity is identified by an IRI and has at most one definition.`,
      constraints: [
        { path: "id", identifies: true, minCount: 1, maxCount: 1, nodeKind: "IRI", comment: "the Activity IRI (\xA75.2.2.3)" },
        { path: "objectType", rdfPath: null, maxCount: 1, in: ["Activity"], comment: "Activity, when present (\xA75.2.2.3); read as rdf:type" },
        { path: "definition", maxCount: 1, comment: "at most one Activity Definition (\xA75.2.2.3)" }
      ]
    },
    {
      name: "InteractionDefinitionShape",
      targetClass: "ActivityDefinition",
      targetObjectsOf: ["definition"],
      label: "Activity Definition conformance",
      comment: `${S} \xA75.2.2.3: interactionType is one of the interaction types; type is an IRI.`,
      constraints: [
        { path: "interactionType", maxCount: 1, in: [...XAPI_INTERACTION_TYPES], comment: "interaction type vocabulary (\xA75.2.2.3)" },
        { path: "type", maxCount: 1, nodeKind: "IRI", comment: "the Activity type IRI (\xA75.2.2.3)" },
        { path: "moreInfo", maxCount: 1, datatype: "xsd:anyURI", comment: "an IRL (\xA75.2.2.3)" },
        { path: "name", datatype: "rdf:langString", comment: "a language map (\xA75.2.2.3)" },
        { path: "description", datatype: "rdf:langString", comment: "a language map (\xA75.2.2.3)" }
      ]
    },
    {
      name: "InteractionComponentShape",
      targetClass: "InteractionComponent",
      targetObjectsOf: ["choices", "scale", "source", "target", "steps"],
      label: "Interaction component conformance",
      comment: `${S} \xA75.2.2.3 (Interaction Components): a component has one id, unique within its list, and a description that is a language map.`,
      constraints: [
        { path: "componentId", jsonPath: "id", minCount: 1, maxCount: 1, datatype: "xsd:string", comment: "the component id (\xA75.2.2.3)" },
        { path: "description", datatype: "rdf:langString", comment: "a language map (\xA75.2.2.3)" }
      ]
    },
    {
      name: "ResultShape",
      targetClass: "Result",
      targetObjectsOf: ["result"],
      label: "Result conformance",
      comment: `${S} \xA75.2.2.4: success and completion are booleans; duration is an ISO 8601 duration.`,
      constraints: [
        { path: "success", maxCount: 1, datatype: "xsd:boolean" },
        { path: "completion", maxCount: 1, datatype: "xsd:boolean" },
        { path: "response", maxCount: 1, datatype: "xsd:string" },
        { path: "duration", maxCount: 1, datatype: "xsd:string", pattern: DURATION, comment: "ISO 8601:2004 \xA74.4.3.2 duration (\xA75.2.7)" },
        { path: "score", maxCount: 1, comment: "at most one Score (\xA75.2.2.4)" }
      ]
    },
    {
      name: "ScoreShape",
      targetClass: "Score",
      targetObjectsOf: ["score"],
      label: "Score conformance",
      comment: `${S} \xA75.2.2.4: scaled is a number in [-1, 1]; raw, min and max are numbers, min less than max, and raw between them.`,
      constraints: [
        { path: "scaled", maxCount: 1, datatype: NUMBER, minInclusive: -1, maxInclusive: 1, comment: "scaled \u2208 [-1, 1] (\xA75.2.2.4)" },
        { path: "raw", maxCount: 1, datatype: NUMBER, lessThanOrEquals: "max", comment: "a number, at most max (\xA75.2.2.4)" },
        { path: "min", maxCount: 1, datatype: NUMBER, lessThan: "max", lessThanOrEquals: "raw", comment: "a number, less than max and at most raw (\xA75.2.2.4)" },
        { path: "max", maxCount: 1, datatype: NUMBER, comment: "a number (\xA75.2.2.4)" }
      ]
    },
    {
      name: "StatementRefShape",
      targetClass: "StatementRef",
      label: "Statement Reference conformance",
      comment: `${S} \xA75.2.2.3: a Statement Reference has objectType StatementRef and the UUID of a Statement.`,
      constraints: [
        { path: "objectType", rdfPath: null, minCount: 1, maxCount: 1, in: ["StatementRef"], comment: "StatementRef (\xA75.2.2.3); read as rdf:type" },
        { path: "id", minCount: 1, maxCount: 1, datatype: "xsd:string", pattern: UUID, comment: "a UUID (\xA75.2.2.3)" }
      ]
    },
    {
      name: "SubStatementShape",
      targetClass: "SubStatement",
      label: "Sub-Statement conformance",
      comment: `${S} \xA75.2.2.3: a Sub-Statement has objectType SubStatement and exactly one actor, verb and object; it has no id, stored, version or authority, and its object is not a Sub-Statement.`,
      constraints: [
        { path: "objectType", rdfPath: null, minCount: 1, maxCount: 1, in: ["SubStatement"], comment: "SubStatement (\xA75.2.2.3); read as rdf:type" },
        { path: "actor", minCount: 1, maxCount: 1 },
        { path: "verb", minCount: 1, maxCount: 1 },
        { path: "object", minCount: 1, maxCount: 1 },
        { path: "id", maxCount: 0, comment: "a Sub-Statement has no id (\xA75.2.2.3)" },
        { path: "stored", maxCount: 0, comment: "a Sub-Statement has no stored (\xA75.2.2.3)" },
        { path: "version", maxCount: 0, comment: "a Sub-Statement has no version (\xA75.2.2.3)" },
        { path: "authority", maxCount: 0, comment: "a Sub-Statement has no authority (\xA75.2.2.3)" },
        { path: "object.objectType", rdfPath: ["object", "rdf:type"], notHasValue: "SubStatement", notHasIri: "SubStatement", comment: "a Sub-Statement does not nest another (\xA75.2.2.3)" }
      ]
    },
    {
      name: "ContextShape",
      targetClass: "Context",
      targetObjectsOf: ["context"],
      label: "Context conformance",
      comment: `${S} \xA75.2.2.5: registration is a UUID; language is an RFC 5646 tag; statement is a Statement Reference; team is a Group.`,
      constraints: [
        { path: "registration", maxCount: 1, datatype: "xsd:string", pattern: UUID, comment: "a UUID (\xA75.2.2.5)" },
        { path: "language", maxCount: 1, datatype: "xsd:language", comment: "an RFC 5646 language tag (\xA75.2.2.5)" },
        { path: "statement", maxCount: 1, class: "StatementRef", comment: "one Statement Reference (\xA75.2.2.5)" },
        { path: "team", maxCount: 1, class: "Group", comment: "one Group (\xA75.2.2.5)" },
        { path: "instructor", maxCount: 1, comment: "one Agent or Group (\xA75.2.2.5)" },
        { path: "contextActivities", maxCount: 1 }
      ]
    },
    {
      // Selected by class, and as a value of contextAgents whatever its type: a context agent without
      // its objectType has no type in the reading, and a shape that targeted the class alone passed it.
      name: "ContextAgentShape",
      targetClass: "ContextAgent",
      targetObjectsOf: ["contextAgents"],
      jsonKeys: ["contextAgents"],
      jsonTypes: ["contextAgent"],
      nodeClass: "ContextAgent",
      label: "Context agent conformance",
      comment: `${S} \xA75.2.2.5: a context agent has objectType contextAgent, exactly one Agent, and relevant types that are IRIs.`,
      constraints: [
        { path: "objectType", rdfPath: null, minCount: 1, maxCount: 1, in: ["contextAgent"], comment: "contextAgent (\xA75.2.2.5); read as rdf:type" },
        { path: "agent", minCount: 1, maxCount: 1 },
        { path: "relevantTypes", nodeKind: "IRI", comment: "type IRIs (\xA75.2.2.5)" }
      ]
    },
    {
      name: "ContextGroupShape",
      targetClass: "ContextGroup",
      targetObjectsOf: ["contextGroups"],
      jsonKeys: ["contextGroups"],
      jsonTypes: ["contextGroup"],
      nodeClass: "ContextGroup",
      label: "Context group conformance",
      comment: `${S} \xA75.2.2.5: a context group has objectType contextGroup, exactly one Group, and relevant types that are IRIs.`,
      constraints: [
        { path: "objectType", rdfPath: null, minCount: 1, maxCount: 1, in: ["contextGroup"], comment: "contextGroup (\xA75.2.2.5); read as rdf:type" },
        { path: "group", minCount: 1, maxCount: 1, class: "Group" },
        { path: "relevantTypes", nodeKind: "IRI", comment: "type IRIs (\xA75.2.2.5)" }
      ]
    },
    {
      name: "AttachmentShape",
      targetClass: "Attachment",
      targetObjectsOf: ["attachments"],
      label: "Attachment conformance",
      comment: `${S} \xA75.2.2.6: usageType (an IRI), display (a language map), contentType, length and sha2 are required.`,
      constraints: [
        { path: "usageType", minCount: 1, maxCount: 1, nodeKind: "IRI" },
        { path: "display", minCount: 1, datatype: "rdf:langString", comment: "a language map, required in xAPI 2.0 (\xA75.2.2.6)" },
        { path: "description", datatype: "rdf:langString", comment: "a language map (\xA75.2.2.6)" },
        { path: "contentType", minCount: 1, maxCount: 1, datatype: "xsd:string", pattern: MEDIA_TYPE },
        { path: "length", minCount: 1, maxCount: 1, datatype: "xsd:integer", minInclusive: 0, comment: "octets (\xA75.2.2.6)" },
        { path: "sha2", minCount: 1, maxCount: 1, datatype: "xsd:string" },
        { path: "fileUrl", maxCount: 1, datatype: "xsd:anyURI" }
      ]
    }
  ]
};

// ../interego-native88/applications/foxxi-content-intelligence/src/xapi-validate.ts
var UUID_RE = new RegExp(XAPI_PATTERNS.uuid, "i");
var IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;
function utcTimestamp(ts) {
  if (UTC_RE.test(ts)) return ts;
  const m = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2})(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?$/.exec(ts);
  if (!m) return ts;
  const d = /* @__PURE__ */ new Date(`${m[1]}T${m[2]}${m[3] ?? ":00"}${(m[5] ?? "Z").toUpperCase()}`);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString();
}
var UTC_RE = new RegExp(RFC3339_UTC_TIMESTAMP);
var VERSION_RE = new RegExp(XAPI_PATTERNS.version);
var INTERACTION_TYPES = new Set(XAPI_INTERACTION_TYPES);
var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isIri = (v) => typeof v === "string" && IRI_RE.test(v);
function extraKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}
var Errs = class {
  list = [];
  add(msg) {
    this.list.push(msg);
  }
};
var AGENT_KEYS = ["objectType", "name", "mbox", "mbox_sha1sum", "openid", "account"];
var GROUP_KEYS = ["objectType", "name", "member", "mbox", "mbox_sha1sum", "openid", "account"];
function validateAccount(v, label, e) {
  if (!isObject(v)) {
    e.add(`${label}.account must be an object`);
    return;
  }
  const extra = extraKeys(v, ["homePage", "name"]);
  if (extra.length) e.add(`${label}.account has unexpected properties: ${extra.join(", ")}`);
  if (!isIri(v.homePage)) e.add(`${label}.account.homePage must be an IRI`);
  if (typeof v.name !== "string" || v.name.length === 0) e.add(`${label}.account.name must be a non-empty string`);
}
function validateIfis(a, label, e) {
  let count = 0;
  if ("mbox" in a) {
    count++;
    if (typeof a.mbox !== "string" || !isIri(a.mbox) || !/^mailto:[^\s@]+@[^\s@]+$/.test(a.mbox)) {
      e.add(`${label}.mbox must be a "mailto:" IRI`);
    }
  }
  if ("mbox_sha1sum" in a) {
    count++;
    if (typeof a.mbox_sha1sum !== "string" || !/^[0-9a-f]{40}$/i.test(a.mbox_sha1sum)) {
      e.add(`${label}.mbox_sha1sum must be a 40-character hex SHA-1 string`);
    }
  }
  if ("openid" in a) {
    count++;
    if (!isIri(a.openid)) e.add(`${label}.openid must be a valid URI`);
  }
  if ("account" in a) {
    count++;
    validateAccount(a.account, label, e);
  }
  return count;
}
function validateActor(v, label, e, role = "actor") {
  if (!isObject(v)) {
    e.add(`${label} must be an object`);
    return;
  }
  const ot = v.objectType;
  if (ot !== void 0 && ot !== "Agent" && ot !== "Group") {
    e.add(`${label}.objectType must be exactly "Agent" or "Group" (got ${JSON.stringify(ot)})`);
    return;
  }
  if (role === "team" && ot !== "Group") {
    e.add(`${label} must be a Group (objectType "Group")`);
  }
  if (v.name !== void 0 && typeof v.name !== "string") {
    e.add(`${label}.name must be a string`);
  }
  const isGroup = ot === "Group";
  const allowed = isGroup ? GROUP_KEYS : AGENT_KEYS;
  const extra = extraKeys(v, allowed);
  if (extra.length) e.add(`${label} has unexpected properties: ${extra.join(", ")}`);
  if (isGroup) {
    const hasMember = "member" in v;
    if (hasMember) {
      if (!Array.isArray(v.member)) e.add(`${label}.member must be an array of Agents`);
      else v.member.forEach((m, i) => validateActor(m, `${label}.member[${i}]`, e, "member"));
    }
    const ifiCount = validateIfis(v, label, e);
    if (ifiCount === 0 && !hasMember) {
      e.add(`${label}: a Group must have an inverse-functional identifier or a "member" array`);
    }
    if (ifiCount > 1) e.add(`${label}: a Group must have at most one inverse-functional identifier`);
    if (role === "authority") {
      if (ifiCount > 0) e.add(`${label}: an authority Group must be anonymous (no inverse-functional identifier)`);
      if (!Array.isArray(v.member) || v.member.length !== 2) {
        e.add(`${label}: an authority Group must consist of exactly two Agents (OAuth consumer)`);
      }
    }
  } else {
    if ("member" in v) e.add(`${label}: only a Group may have a "member" property`);
    const ifiCount = validateIfis(v, label, e);
    if (ifiCount === 0) e.add(`${label}: an Agent must have exactly one inverse-functional identifier (mbox / mbox_sha1sum / openid / account)`);
    if (ifiCount > 1) e.add(`${label}: an Agent must have exactly one inverse-functional identifier, found ${ifiCount}`);
  }
}
function validateAgentObject(agent) {
  const e = new Errs();
  validateActor(agent, "agent", e);
  return e.list;
}

// ../interego-native88/applications/foxxi-content-intelligence/src/native-lrs-store.ts
var PREFIX2 = "foxxi-lrs/v1/";
var RECORD_TYPE = "application/vnd.foxxi.lrs-record+json";
var MAX_SCAN = 4096;
var CURSOR_LIFETIME = 60 * 60 * 1e3;
var UTC_TIMESTAMP = new RegExp(RFC3339_UTC_TIMESTAMP);
var InvalidLrsQueryError = class extends Error {
  status = 400;
  constructor(message = "invalid LRS query") {
    super(message);
    this.name = "InvalidLrsQueryError";
  }
};
function bounded2(value2, label, max) {
  if (typeof value2 !== "string" || !value2 || value2.length > max || value2.includes("\0")) throw new Error("invalid LRS " + label);
}
function stableJson(value2) {
  return JSON.stringify(value2, (_key, item) => item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function checkedQuery(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2)) throw new InvalidLrsQueryError();
  const q = value2;
  if (Object.keys(q).some((k) => !["agent", "verb", "activity", "registration", "since", "until", "ascending", "limit"].includes(k))) throw new InvalidLrsQueryError();
  if (q.limit !== void 0 && (typeof q.limit !== "number" || !Number.isSafeInteger(q.limit) || q.limit < 0)) throw new InvalidLrsQueryError();
  if (q.ascending !== void 0 && typeof q.ascending !== "boolean") throw new InvalidLrsQueryError();
  for (const key of ["verb", "activity"]) {
    const v = q[key];
    if (v !== void 0 && (typeof v !== "string" || v.length > 8192 || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(v))) throw new InvalidLrsQueryError();
  }
  if (q.registration !== void 0 && (typeof q.registration !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(q.registration))) throw new InvalidLrsQueryError();
  for (const key of ["since", "until"]) {
    const v = q[key];
    if (v !== void 0 && (typeof v !== "string" || v.length > 128 || !UTC_TIMESTAMP.test(utcTimestamp(v)) || !Number.isFinite(Date.parse(utcTimestamp(v))))) throw new InvalidLrsQueryError();
  }
  if (q.agent !== void 0 && (typeof q.agent !== "object" || q.agent === null || Array.isArray(q.agent) || JSON.stringify(q.agent).length > 8192 || validateAgentObject(q.agent).length)) throw new InvalidLrsQueryError();
  return { ...cursorQueryOf(q), limit: q.limit === 0 ? 500 : Math.min(q.limit ?? 100, 500), ascending: q.ascending === true };
}
function encodeValue(value2) {
  if (Buffer.isBuffer(value2)) return ["bytes", value2.toString("base64")];
  if (value2 === null || ["string", "boolean"].includes(typeof value2) || typeof value2 === "number" && Number.isFinite(value2)) return ["value", value2];
  if (Array.isArray(value2)) return ["array", value2.map(encodeValue)];
  if (value2 && typeof value2 === "object") return ["object", Object.entries(value2).filter(([, v]) => v !== void 0).map(([k, v]) => [k, encodeValue(v)])];
  throw new Error("LRS storage requires finite JSON values or binary documents");
}
function decodeValue(encoded) {
  if (!Array.isArray(encoded) || encoded.length !== 2) throw new Error("invalid native LRS value");
  const [kind, value2] = encoded;
  if (kind === "bytes" && typeof value2 === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value2)) return Buffer.from(value2, "base64");
  if (kind === "value" && (value2 === null || ["string", "boolean"].includes(typeof value2) || typeof value2 === "number" && Number.isFinite(value2))) return value2;
  if (kind === "array" && Array.isArray(value2)) return value2.map(decodeValue);
  if (kind === "object" && Array.isArray(value2)) return Object.fromEntries(value2.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") throw new Error("invalid native LRS object");
    return [entry[0], decodeValue(entry[1])];
  }));
  throw new Error("invalid native LRS value");
}
function immutableBody(record, ignoreAssignedTimestamp) {
  const body = { ...record.statement };
  delete body.stored;
  delete body.authority;
  if (ignoreAssignedTimestamp) delete body.timestamp;
  return stableJson(body);
}
var voidTarget = (s) => {
  const verb = s.verb, object2 = s.object;
  return verb?.id === "http://adlnet.gov/expapi/verbs/voided" && object2?.objectType === "StatementRef" && typeof object2.id === "string" ? object2.id : null;
};
function checkedStatement(value2, id) {
  if (!value2 || value2.id !== id || value2.statement?.id !== id || typeof value2.stored !== "string" || !Number.isFinite(Date.parse(value2.stored)) || new Date(value2.stored).toISOString() !== value2.stored || value2.statement.stored !== value2.stored || value2.voided !== false || value2.voidingStatementId !== void 0 || value2.timestampAssignedByLrs !== void 0 && typeof value2.timestampAssignedByLrs !== "boolean") throw new Error("invalid immutable native LRS statement");
  return value2;
}
var NativeMutation = class {
  constructor(database, snapshot) {
    this.database = database;
    this.snapshot = snapshot;
  }
  database;
  snapshot;
  changes = /* @__PURE__ */ new Map();
  values = /* @__PURE__ */ new Map();
  async read(tenant, kind, id) {
    const key = this.database.key(tenant, kind, id);
    if (this.values.has(key)) return this.values.get(key);
    return this.database.read(this.snapshot, tenant, kind, id);
  }
  write(tenant, kind, id, value2) {
    const artifact = this.database.artifact(tenant, kind, id, value2);
    const key = this.database.key(tenant, kind, id);
    this.changes.set(key, { key, artifact });
    this.values.set(key, value2);
    return artifact;
  }
  remove(key) {
    this.changes.set(key, { key, artifact: null });
    this.values.set(key, null);
  }
  async registerTenant(tenant) {
    if (await this.read(tenant, "registry", "tenant") === null) this.write(tenant, "registry", "tenant", tenant);
  }
};
var NativeInteregoLrsDatabase = class {
  constructor(options) {
    this.options = options;
    this.secret = Buffer.from(options.cursorSecret);
    if (this.secret.length < 32) throw new Error("native LRS requires a stable cursor secret of at least 32 bytes");
    bounded2(options.scopeIdentity, "native scope", 8192);
  }
  options;
  closed = false;
  readiness;
  secret;
  get client() {
    return this.options.client;
  }
  get owner() {
    return this.options.owner;
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
  digest(value2) {
    return createHmac("sha256", this.secret).update(JSON.stringify([this.options.scopeIdentity, value2])).digest("hex");
  }
  prefix(tenant) {
    return PREFIX2 + this.digest(tenant) + "/";
  }
  key(tenant, kind, id) {
    bounded2(tenant, "tenant", 8192);
    bounded2(kind, "record kind", 64);
    bounded2(id, "record ID", 65536);
    return this.prefix(tenant) + kind + "/" + this.digest(JSON.stringify([tenant, kind, id]));
  }
  queryKey(tenant, record) {
    return this.prefix(tenant) + "query/" + record.stored + "/" + this.digest(JSON.stringify([tenant, "statement", record.id]));
  }
  signature(tenant, cursor) {
    return createHmac("sha256", this.secret).update(JSON.stringify([this.options.scopeIdentity, tenant, stableJson(cursor)])).digest("hex");
  }
  artifact(tenant, kind, id, value2) {
    const envelope = { format: "foxxi-native-lrs/1", tenant, kind, id, value: encodeValue(value2) };
    return createNativeByteArtifact({ owner: this.owner, contentType: RECORD_TYPE, bytes: Buffer.from(JSON.stringify(envelope), "utf8") });
  }
  async readReference(snapshot, key, tenant, kind, id) {
    const reference = snapshot.records.get(key);
    if (!reference) return null;
    const payload = readNativeByteArtifact(await this.client.readArtifact(reference));
    if (payload.owner !== this.owner || payload.contentType !== RECORD_TYPE) throw new Error("native LRS artifact owner/type binding failed");
    const envelope = JSON.parse(Buffer.from(payload.bytes).toString("utf8"));
    if (envelope.format !== "foxxi-native-lrs/1" || envelope.tenant !== tenant || envelope.kind !== kind || id !== void 0 && envelope.id !== id) throw new Error("native LRS artifact/index binding failed");
    const decoded = decodeValue(envelope.value);
    if (decoded === null || decoded === void 0) throw new Error("native LRS artifact contains an absent record");
    if (kind === "statement") checkedStatement(decoded, envelope.id);
    const expectedKey = kind === "statement" && key.startsWith(this.prefix(tenant) + "query/") ? this.queryKey(tenant, checkedStatement(decoded, envelope.id)) : this.key(tenant, kind, envelope.id);
    if (expectedKey !== key) throw new Error("native LRS artifact/index binding failed");
    return decoded;
  }
  async read(snapshot, tenant, kind, id) {
    return this.readReference(snapshot, this.key(tenant, kind, id), tenant, kind, id);
  }
  async ready() {
    if (this.closed) throw new Error("native LRS is closed");
    if (!this.readiness) this.readiness = (async () => {
      await this.client.ready();
      await this.options.verifyReadiness?.();
      for (let attempt = 0; attempt < 8; attempt++) {
        const expected = await this.client.readHead();
        try {
          await this.client.commit({ operationId: randomUUID(), expected, changes: [] });
          return;
        } catch (error) {
          if (!(error instanceof NativeCommitConflictError) || attempt === 7) throw error;
        }
      }
    })();
    const pending = this.readiness;
    try {
      await pending;
    } catch (error) {
      if (pending === this.readiness) this.readiness = void 0;
      throw error;
    }
  }
  async transaction(prepare) {
    await this.ready();
    for (let attempt = 0; attempt < 8; attempt++) {
      const mutation = new NativeMutation(this, await this.client.readHead());
      const result = await prepare(mutation);
      if (!mutation.changes.size) return result;
      try {
        await this.client.commit({ operationId: randomUUID(), expected: mutation.snapshot, changes: [...mutation.changes.values()] });
        return result;
      } catch (error) {
        if (!(error instanceof NativeCommitConflictError)) throw error;
        if (attempt === 7) throw new Error("native LRS commit contention limit reached");
      }
    }
    throw new Error("native LRS commit contention limit reached");
  }
  forTenant(tenant) {
    bounded2(tenant, "tenant", 8192);
    return new NativeInteregoLrsStore(this, tenant);
  }
  async listTenants() {
    await this.ready();
    const head = await this.client.readHead(), names = [];
    for (const [key, ref] of head.records) {
      if (!key.startsWith(PREFIX2) || !key.includes("/registry/")) continue;
      const value2 = readNativeByteArtifact(await this.client.readArtifact(ref));
      if (value2.owner !== this.owner || value2.contentType !== RECORD_TYPE) throw new Error("native LRS tenant registry owner/type binding failed");
      const row = JSON.parse(Buffer.from(value2.bytes).toString("utf8"));
      const tenant = decodeValue(row.value);
      if (row.format !== "foxxi-native-lrs/1" || row.kind !== "registry" || row.id !== "tenant" || typeof tenant !== "string" || row.tenant !== tenant || this.key(tenant, "registry", "tenant") !== key) throw new Error("native LRS tenant registry binding failed");
      names.push(tenant);
    }
    return names.sort();
  }
  clearAllowed() {
    return this.options.allowClear === true;
  }
  async close() {
    this.closed = true;
    this.secret.fill(0);
  }
};
var NativeInteregoLrsStore = class {
  constructor(database, tenant) {
    this.database = database;
    this.tenant = tenant;
  }
  database;
  tenant;
  async getAt(head, id) {
    const record = await this.database.read(head, this.tenant, "statement", id);
    if (!record) return null;
    checkedStatement(record, id);
    const relation = await this.database.read(head, this.tenant, "void", id);
    if (!relation) return record;
    const voider = await this.database.read(head, this.tenant, "statement", relation.voidingStatementId);
    if (relation.target !== id || !voider || voidTarget(checkedStatement(voider, relation.voidingStatementId).statement) !== id || voidTarget(record.statement)) throw new Error("native LRS void relationship binding failed");
    return { ...record, voided: true, voidingStatementId: relation.voidingStatementId };
  }
  async put(record) {
    await this.putWithAttachments(record, /* @__PURE__ */ new Map());
  }
  async putWithAttachments(record, attachments, registration) {
    return this.putBatchWithAttachments([record], attachments, registration);
  }
  /** Whole HTTP batch + exact envelopes + attachment bytes + guarded void edges share one native CAS. */
  async putBatchWithAttachments(records, attachments, registration) {
    if (!records.length) {
      if (attachments.size) throw new Error("native LRS attachment commit requires a statement");
      return { records: [], inserted: [], appliedVoids: [] };
    }
    const ids = /* @__PURE__ */ new Set();
    for (const row of records) {
      checkedStatement(row, row.id);
      if (ids.has(row.id)) throw new ConflictError("duplicate statement UUID in batch");
      ids.add(row.id);
    }
    return this.database.transaction(async (tx) => {
      await tx.registerTenant(this.tenant);
      const kept = [], inserted = [];
      for (const row of records) {
        const prior = await tx.read(this.tenant, "statement", row.id);
        const ignoreAssignedTimestamp = prior?.timestampAssignedByLrs === true && row.timestampAssignedByLrs === true;
        if (prior && immutableBody(prior, ignoreAssignedTimestamp) !== immutableBody(row, ignoreAssignedTimestamp)) throw new ConflictError("statement id " + row.id + " already stored with different content");
        kept.push(prior ? checkedStatement(prior, row.id) : row);
        if (!prior) {
          inserted.push(row);
          const artifact = tx.write(this.tenant, "statement", row.id, row);
          const key = this.database.queryKey(this.tenant, row);
          tx.changes.set(key, { key, artifact });
        }
      }
      for (const [sha, attachment] of attachments) {
        if (!/^[a-f0-9]{64}$/i.test(sha) || createHash5("sha256").update(attachment.data).digest("hex") !== sha.toLowerCase()) throw new Error("LRS attachment hash does not match its bytes");
        bounded2(attachment.contentType, "attachment content type", 1024);
        const key = this.database.key(this.tenant, "attachment", sha.toLowerCase());
        const prior = tx.snapshot.records.get(key);
        if (prior) {
          const old = readNativeByteArtifact(await this.database.client.readArtifact(prior));
          if (old.sha256 !== "sha256:" + sha.toLowerCase() || old.owner !== this.database.owner || old.contentType !== attachment.contentType || !Buffer.from(old.bytes).equals(attachment.data)) throw new ConflictError("attachment already stored with different metadata");
        } else tx.changes.set(key, { key, artifact: createNativeByteArtifact({ owner: this.database.owner, contentType: attachment.contentType, bytes: attachment.data }) });
      }
      const applied = [];
      for (const row of inserted) {
        const id = voidTarget(row.statement);
        if (!id) continue;
        const target = await tx.read(this.tenant, "statement", id);
        if (!target || voidTarget(target.statement) || registration !== void 0 && target.statement.context?.registration !== registration) continue;
        tx.write(this.tenant, "void", id, { target: id, voidingStatementId: row.id });
        applied.push({ target: { ...target, voided: true, voidingStatementId: row.id }, voidingStatementId: row.id });
      }
      return { records: kept, inserted, appliedVoids: applied };
    });
  }
  async get(id) {
    await this.database.ready();
    return this.getAt(await this.database.client.readHead(), id);
  }
  async markVoided(id, voidingStatementId, onlyIf) {
    return this.database.transaction(async (tx) => {
      const target = await this.getAt(tx.snapshot, id);
      const voider = await tx.read(this.tenant, "statement", voidingStatementId);
      if (!target || !voider || voidTarget(voider.statement) !== id || voidTarget(target.statement) || onlyIf && !onlyIf(target)) return false;
      await tx.registerTenant(this.tenant);
      tx.write(this.tenant, "void", id, { target: id, voidingStatementId });
      return true;
    });
  }
  queryEntries(head) {
    const prefix = this.database.prefix(this.tenant), statementPrefix = prefix + "statement/", queryPrefix = prefix + "query/";
    const statements = new Map([...head.records].filter(([key]) => key.startsWith(statementPrefix)).map(([key, ref]) => [key.slice(statementPrefix.length), ref]));
    const seen = /* @__PURE__ */ new Set(), rows = [];
    for (const [key, ref] of head.records) {
      if (!key.startsWith(queryPrefix)) continue;
      const suffix = key.slice(queryPrefix.length), stored = suffix.slice(0, 24), opaque = suffix.slice(25);
      const primary = statements.get(opaque);
      if (suffix[24] !== "/" || !/^[a-f0-9]{64}$/.test(opaque) || !Number.isFinite(Date.parse(stored)) || new Date(stored).toISOString() !== stored || !primary || primary.plaintextDigest !== ref.plaintextDigest || primary.topUri !== ref.topUri || seen.has(opaque)) throw new Error("native LRS query view binding failed");
      seen.add(opaque);
      rows.push({ key, stored, opaque });
    }
    if (seen.size !== statements.size) throw new Error("native LRS query view incomplete; rebuild from native statement artifacts before serving");
    return rows;
  }
  cursor(token, query, authorizationRegistration) {
    if (token.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new InvalidLrsQueryError("invalid LRS continuation token");
    let value2;
    try {
      value2 = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    } catch {
      throw new InvalidLrsQueryError();
    }
    if (!value2 || Object.keys(value2).some((k) => !["offset", "q", "head", "after", "expires", "authorizationRegistration", "proof"].includes(k)) || value2.authorizationRegistration !== authorizationRegistration || !Number.isSafeInteger(value2.offset) || value2.offset < 0 || !Number.isSafeInteger(value2.expires) || value2.expires <= this.database.now() || value2.expires > this.database.now() + CURSOR_LIFETIME || typeof value2.after !== "string" || value2.after.length > 1024 || !value2.after.startsWith(this.database.prefix(this.tenant) + "query/") || !value2.head || Object.keys(value2.head).some((k) => !["revision", "commitUrl", "topUri"].includes(k)) || !["revision", "commitUrl", "topUri"].every((k) => {
      const field = value2.head[k];
      return typeof field === "string" && field.length <= 8192;
    }) || typeof value2.proof !== "string" || !/^[a-f0-9]{64}$/.test(value2.proof) || stableJson(checkedQuery(value2.q)) !== stableJson(query)) throw new InvalidLrsQueryError("invalid LRS continuation token");
    const { proof, ...body } = value2;
    if (!timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(this.database.signature(this.tenant, body), "hex"))) throw new InvalidLrsQueryError("invalid LRS continuation signature");
    return value2;
  }
  async query(filter) {
    await this.database.ready();
    const q = checkedQuery(cursorQueryOf(filter));
    const authorizationRegistration = filter.authorizedRegistration ?? null;
    if (authorizationRegistration !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(authorizationRegistration)) throw new InvalidLrsQueryError();
    if (filter.statementId || filter.voidedStatementId) {
      if (filter.cursor || filter.statementId && filter.voidedStatementId) throw new InvalidLrsQueryError();
      const record = await this.get(filter.statementId ?? filter.voidedStatementId);
      return { statements: record && record.voided === !!filter.voidedStatementId && (authorizationRegistration === null || record.statement.context?.registration === authorizationRegistration) ? [record] : [], more: null };
    }
    const cursor = filter.cursor === void 0 ? null : this.cursor(filter.cursor, q, authorizationRegistration);
    const head = cursor ? await this.database.client.readSnapshotAt(cursor.head) : await this.database.client.readHead();
    const index = this.queryEntries(head).sort((a, b) => (q.ascending ? a.stored.localeCompare(b.stored) : b.stored.localeCompare(a.stored)) || a.opaque.localeCompare(b.opaque));
    let start = 0;
    if (cursor) {
      const found = index.findIndex((row) => row.key === cursor.after);
      if (found < 0) throw new InvalidLrsQueryError();
      start = found + 1;
    }
    const statements = [];
    let next = start;
    for (; next < index.length && next - start < MAX_SCAN && statements.length < q.limit; next++) {
      const row = index[next];
      const base = await this.database.readReference(head, row.key, this.tenant, "statement");
      if (!base || this.database.queryKey(this.tenant, checkedStatement(base, base.id)) !== row.key) throw new Error("native LRS query timestamp binding failed");
      const record = await this.getAt(head, base.id);
      if (!record || record.voided || authorizationRegistration !== null && record.statement.context?.registration !== authorizationRegistration) continue;
      let matches = matchesFilter2(record, q);
      const targetId = voidTarget(record.statement);
      if (!matches && targetId) {
        const target = await this.getAt(head, targetId);
        matches = !!target?.voided && target.voidingStatementId === record.id && matchesFilter2(target, q);
      }
      if (matches) statements.push(record);
    }
    if (next >= index.length) return { statements, more: null };
    if (!head.reference || next <= start) throw new Error("native LRS pagination requires a committed snapshot");
    const body = { offset: (cursor?.offset ?? 0) + statements.length, q, head: head.reference, after: index[next - 1].key, authorizationRegistration, expires: cursor?.expires ?? this.database.now() + CURSOR_LIFETIME };
    const signed = { ...body, proof: this.database.signature(this.tenant, body) };
    return { statements, more: encodeCursor(signed) };
  }
  async listAll() {
    await this.database.ready();
    const head = await this.database.client.readHead(), prefix = this.database.prefix(this.tenant) + "statement/", records = [];
    for (const key of head.records.keys()) {
      if (!key.startsWith(prefix)) continue;
      const base = await this.database.readReference(head, key, this.tenant, "statement");
      if (base) {
        const row = await this.getAt(head, checkedStatement(base, base.id).id);
        if (row) records.push(row);
      }
    }
    return records;
  }
  async count() {
    await this.database.ready();
    const prefix = this.database.prefix(this.tenant) + "statement/";
    return [...(await this.database.client.readHead()).records.keys()].filter((key) => key.startsWith(prefix)).length;
  }
  async clear() {
    if (!this.database.clearAllowed()) throw new Error("native LRS clear is disabled");
    await this.database.transaction(async (tx) => {
      for (const key of tx.snapshot.records.keys()) if (key.startsWith(this.database.prefix(this.tenant))) tx.remove(key);
    });
  }
  backendDescription() {
    return "interego (encrypted canonical PGSL artifacts; awaited native atomic commits; rebuildable xAPI view)";
  }
  async getResource(kind, id) {
    await this.database.ready();
    return this.database.read(await this.database.client.readHead(), this.tenant, kind, id);
  }
  async listResources(kind) {
    await this.database.ready();
    bounded2(kind, "record kind", 64);
    const head = await this.database.client.readHead(), prefix = this.database.prefix(this.tenant) + kind + "/", result = [];
    for (const [key, ref] of head.records) {
      if (!key.startsWith(prefix)) continue;
      const payload = readNativeByteArtifact(await this.database.client.readArtifact(ref));
      if (payload.owner !== this.database.owner || payload.contentType !== RECORD_TYPE) throw new Error("native LRS resource owner/type binding failed");
      const row = JSON.parse(Buffer.from(payload.bytes).toString("utf8"));
      if (row.format !== "foxxi-native-lrs/1" || row.tenant !== this.tenant || row.kind !== kind || this.database.key(this.tenant, kind, row.id) !== key) throw new Error("native LRS resource binding failed");
      result.push([row.id, decodeValue(row.value)]);
    }
    return result;
  }
  async updateResource(kind, id, mutate) {
    if (["statement", "attachment", "void", "registry", "query"].includes(kind)) throw new Error("use the immutable native LRS record methods");
    return this.database.transaction(async (tx) => {
      const next = mutate(await tx.read(this.tenant, kind, id));
      if (next.value === null) tx.remove(this.database.key(this.tenant, kind, id));
      else {
        await tx.registerTenant(this.tenant);
        tx.write(this.tenant, kind, id, next.value);
      }
      return next.result;
    });
  }
  async putResource(kind, id, value2) {
    await this.updateResource(kind, id, () => ({ value: value2, result: void 0 }));
  }
  async deleteResource(kind, id) {
    await this.updateResource(kind, id, () => ({ value: null, result: void 0 }));
  }
  async getAttachment(sha) {
    if (!/^[a-f0-9]{64}$/i.test(sha)) throw new Error("invalid LRS attachment hash");
    await this.database.ready();
    const ref = (await this.database.client.readHead()).records.get(this.database.key(this.tenant, "attachment", sha.toLowerCase()));
    if (!ref) return null;
    const value2 = readNativeByteArtifact(await this.database.client.readArtifact(ref));
    if (value2.owner !== this.database.owner || value2.sha256 !== "sha256:" + sha.toLowerCase()) throw new Error("native LRS attachment binding failed");
    return { data: Buffer.from(value2.bytes), contentType: value2.contentType };
  }
  /** Recover the query projection solely from complete verified native statement artifacts. */
  async rebuildQueryView() {
    await this.database.transaction(async (tx) => {
      const prefix = this.database.prefix(this.tenant);
      for (const key of tx.snapshot.records.keys()) if (key.startsWith(prefix + "query/")) tx.remove(key);
      for (const key of tx.snapshot.records.keys()) {
        if (!key.startsWith(prefix + "statement/")) continue;
        const row = await this.database.readReference(tx.snapshot, key, this.tenant, "statement");
        if (!row) throw new Error("native statement artifact disappeared");
        checkedStatement(row, row.id);
        const queryKey = this.database.queryKey(this.tenant, row);
        const reference = tx.snapshot.records.get(key);
        if (!reference) throw new Error("native statement reference disappeared");
        const source = await this.database.client.readArtifact(reference), top = source.nodes.get(source.topUri);
        if (!top) throw new Error("native statement top disappeared");
        tx.changes.set(queryKey, { key: queryKey, artifact: {
          topUri: source.topUri,
          pgsl: { atoms: /* @__PURE__ */ new Map(), fragments: /* @__PURE__ */ new Map(), nodes: new Map(source.nodes), defaultProvenance: top.provenance }
        } });
      }
    });
  }
};

// ../interego-native88/applications/foxxi-content-intelligence/src/statement-store.ts
function matchesFilter2(rec, f) {
  const s = rec.statement;
  if (f.agent) {
    const a = s.actor;
    const fa = f.agent;
    const same = JSON.stringify(a) === JSON.stringify(fa) || fa?.mbox && a?.mbox === fa.mbox || fa?.openid && a?.openid === fa.openid || fa?.account?.name && a?.account?.name === fa.account.name && a?.account?.homePage === fa.account.homePage;
    if (!same) return false;
  }
  if (f.verb && s.verb?.id !== f.verb) return false;
  if (f.activity && s.object?.id !== f.activity) return false;
  if (f.registration && s.context?.registration !== f.registration) return false;
  if (f.since && Date.parse(rec.stored) <= Date.parse(f.since)) return false;
  if (f.until && Date.parse(rec.stored) > Date.parse(f.until)) return false;
  return true;
}
function encodeCursor(c) {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
function cursorQueryOf(f) {
  const q = {};
  if (f.agent !== void 0) q.agent = f.agent;
  if (f.verb !== void 0) q.verb = f.verb;
  if (f.activity !== void 0) q.activity = f.activity;
  if (f.registration !== void 0) q.registration = f.registration;
  if (f.since !== void 0) q.since = f.since;
  if (f.until !== void 0) q.until = f.until;
  if (f.ascending !== void 0) q.ascending = f.ascending;
  if (f.limit !== void 0) q.limit = f.limit;
  return q;
}
function defaultResidentBudget() {
  const override2 = Number(process.env.FOXXI_LRS_MEMORY_MAX_STATEMENTS ?? "");
  if (Number.isFinite(override2) && override2 > 0) return Math.floor(override2);
  return Math.max(1e4, Math.floor(getHeapStatistics().heap_size_limit * 0.4 / 1024));
}
var residentBudget = defaultResidentBudget();
var ConflictError = class extends Error {
  constructor(msg) {
    super(msg);
    this.name = "ConflictError";
  }
};
function isProductionLrsEnvironment(env = process.env) {
  return env.NODE_ENV === "production" || Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_SERVICE_ID);
}
function nativeConfiguration(env) {
  const pod = env.FOXXI_LRS_NATIVE_POD_URL, owner = env.FOXXI_LRS_NATIVE_OWNER;
  const capability = env.FOXXI_LRS_NATIVE_CAPABILITY;
  const privateKey = env.FOXXI_LRS_NATIVE_PRIVATE_KEY || env.FOXXI_BRIDGE_PRIVATE_KEY;
  const ownerPublicKey = env.FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY;
  if (!pod || !owner || !capability || !privateKey || !ownerPublicKey) throw new Error("Interego LRS requires a native pod, owner, explicit capability, stable private key and pinned owner encryption public key");
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(owner) || owner.length > 4096) throw new Error("invalid native LRS owner");
  if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(privateKey)) throw new Error("native LRS requires an existing stable wallet private key");
  const publicBytes = Buffer.from(ownerPublicKey, "base64");
  if (publicBytes.length !== 32 || publicBytes.toString("base64") !== ownerPublicKey) throw new Error("native LRS owner encryption key must be pinned canonical 32-byte base64");
  if (capability.length > 16384 || /[\r\n\u0000]/.test(capability)) throw new Error("invalid native LRS capability");
  const podUrl = new URL(pod);
  const checkedUrl = (value2, container = false) => {
    const url = new URL(value2);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && !isProductionLrsEnvironment(env) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) || url.username || url.password || url.hash || url.search || /%2e|%2f|%5c/i.test(url.pathname) || url.origin !== podUrl.origin || !url.pathname.startsWith(podUrl.pathname) || container && !url.pathname.endsWith("/")) throw new Error("native LRS resources must stay inside their configured pod");
    return url.href;
  };
  if (!podUrl.pathname.endsWith("/")) throw new Error("native LRS pod URL must end in /");
  const scope = {
    pod: checkedUrl(pod, true),
    owner,
    headUrl: checkedUrl(env.FOXXI_LRS_NATIVE_HEAD_URL || new URL("foxxi/lrs/native/head", pod).href),
    artifactContainer: checkedUrl(env.FOXXI_LRS_NATIVE_ARTIFACT_CONTAINER || new URL("foxxi/lrs/native/artifacts/", pod).href, true)
  };
  return { scope, capability, privateKey, ownerPublicKey };
}
function createConfiguredNativeLrsDatabase(env = process.env) {
  const config = nativeConfiguration(env), originalFetch = globalThis.fetch.bind(globalThis);
  const senderKeyPair = deriveEncryptionKeyPair(config.privateKey, config.scope.owner);
  const pod = new URL(config.scope.pod);
  const transport = async (input, init) => {
    const request = input instanceof Request ? input : void 0;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== pod.origin || !url.pathname.startsWith(pod.pathname) || url.username || url.password || url.hash || url.search || /%2e|%2f|%5c/i.test(url.pathname)) throw new Error("native LRS transport left its authorized pod scope");
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.set("Authorization", "Bearer " + config.capability);
    return originalFetch(input, {
      ...init,
      headers,
      method: init?.method ?? request?.method ?? "GET",
      redirect: "manual",
      signal: init?.signal ?? AbortSignal.timeout(15e3)
    });
  };
  const client = new NativeCommitStore({
    scope: config.scope,
    fetch: transport,
    senderKeyPair,
    ownerPublicKey: config.ownerPublicKey,
    recipientPublicKeys: [.../* @__PURE__ */ new Set([config.ownerPublicKey, senderKeyPair.publicKey])]
  });
  return new NativeInteregoLrsDatabase({
    client,
    owner: config.scope.owner,
    scopeIdentity: JSON.stringify(config.scope),
    cursorSecret: createNativeCursorSecret(config.privateKey, config.scope.owner)
  });
}
function createNativeCursorSecret(privateKey, owner) {
  return Buffer.from(deriveEncryptionKeyPair(privateKey, "urn:foxxi:native-lrs:cursor:" + owner).secretKey, "base64");
}

// ../interego-native88/applications/foxxi-content-intelligence/src/tenant-publisher.ts
init_src();

// ../interego-native88/applications/foxxi-content-intelligence/src/auth.ts
var enc = new TextEncoder();
var TOKEN_TTL_MS = 24 * 60 * 60 * 1e3;
var AGENT_SIG_REPLAY_WINDOW_MS = (() => {
  const v = Number(process.env.AGENT_SIG_REPLAY_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 3e5;
})();

// ../interego-native88/applications/foxxi-content-intelligence/src/tenant-publisher.ts
import { createHash as createHash6 } from "node:crypto";
var FXS = FOXXI_NS;
var FXA = FOXXI_NS;
var TENANT_TYPES = {
  CourseCatalog: `${FXS}CourseCatalog`,
  TenantDirectory: `${FXS}TenantDirectory`,
  /**
   * PUBLIC membership allowlist — the self-sovereign counterpart to
   * TenantDirectory. Carries only public identifiers (user_id, web_id,
   * wallet_address), published UNENCRYPTED so ANY bridge can read it via
   * the substrate with no shared admin key. A tenant that publishes this
   * (and no encrypted TenantDirectory) is a self-sovereign, open tenant;
   * one with an encrypted TenantDirectory is a closed, admin-managed tenant
   * and its public-membership overlay (if any) is deliberately IGNORED.
   */
  TenantMembership: `${FXS}TenantMembership`,
  AssignmentPolicySet: `${FXS}AssignmentPolicySet`,
  /**
   * PUBLIC audience→course assignment policies — the self-sovereign counterpart
   * to the admin-encrypted AssignmentPolicySet (same rationale as
   * TenantMembership). A self-sovereign tenant publishes its assignments in the
   * clear so ANY bridge reads them via the substrate with no admin key; a closed
   * tenant keeps its encrypted AssignmentPolicySet and its public overlay (if
   * any) is ignored by the closed-tenant guard. NOTE: CourseCatalog is ALREADY
   * public (not in ADMIN_ONLY_TYPES), so the catalog needs no public twin —
   * ingest upserts the existing CourseCatalog section directly.
   */
  TenantAssignments: `${FXS}TenantAssignments`,
  /**
   * PUBLIC register of the pods whose trajectory steps the mesh projector reads.
   *
   * ── ★★ DURABLE ENROLMENT IS NOT A CONFIG EDIT ────────────────────────────────
   *
   * This started as an environment variable (FOXXI_MESH_PODS), which made "whose evidence does a
   * reviewer read" answerable only by a human with deployment access — and a fleet of agents cannot
   * scale through a person editing config. Runtime enrolment fixed the answer but not its lifetime:
   * an in-memory set is cleared by any restart, so an agent's enrolment silently lapses on the next
   * deploy. Both failures are the same one — state the system acts on that its subjects can neither
   * see nor change.
   *
   * So the register is a PUBLIC section on the pod, like TenantMembership: no PII (a pod URL, an
   * enrolling identity, a timestamp), unencrypted so any bridge reads it via the substrate with no
   * admin key, and dereferenceable rather than trapped in a process. The env var remains only as a
   * bootstrap SEED for a fresh deployment.
   *
   * ★ Authority does not widen by persisting: the pod written into a row can only ever be the
   * caller's own (selfBoundPod), and every field is derived from the proven identity — there is no
   * caller-supplied text in a row.
   */
  MeshEnrolmentRegister: `${FXA}MeshEnrolmentRegister`,
  ConnectorRegistry: `${FXS}ConnectorRegistry`,
  EnrollmentEventStream: `${FXA}EnrollmentEventStream`,
  AuditLogStream: `${FXA}AuditLogStream`,
  CoursePackageBundle: `${FXA}CoursePackageBundle`,
  AdminEncryptionKey: `${FXS}AdminEncryptionKey`,
  AbacPolicy: `${FXA}AbacPolicy`
};
var ADMIN_ONLY_TYPES = /* @__PURE__ */ new Set([
  TENANT_TYPES.TenantDirectory,
  TENANT_TYPES.AssignmentPolicySet,
  TENANT_TYPES.ConnectorRegistry,
  TENANT_TYPES.EnrollmentEventStream,
  TENANT_TYPES.AuditLogStream
]);
var BUNDLE_JSON_PRED = `${FXS}bundleJson`;
function deriveAdminKeyPair(seed) {
  const priv = createHash6("sha256").update(`foxxi-admin-x25519:${seed}`).digest();
  return deriveEncryptionKeyPair(priv.toString("hex"));
}

// ../interego-native88/applications/foxxi-content-intelligence/src/tenant-fetcher.ts
var TTL_MS = 6e4;
var CACHE_MAX = 2e3;
var cache = /* @__PURE__ */ new Map();
function cacheKey(podUrl, authoritativeSource, kind) {
  return `${podUrl}|${authoritativeSource}|${kind}`;
}
function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    cache.delete(key);
    return null;
  }
  return e.value;
}
function setCached(key, value2) {
  if (cache.size >= CACHE_MAX && !cache.has(key)) {
    const now = Date.now();
    for (const [k, e] of cache) {
      if (now > e.expiresAt) cache.delete(k);
    }
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== void 0) cache.delete(oldest);
    }
  }
  cache.set(key, { value: value2, expiresAt: Date.now() + TTL_MS });
}
function resolveAdminKeyPair(config) {
  if (config.adminKeyPair) return config.adminKeyPair;
  if (config.adminKeySeed) return deriveAdminKeyPair(config.adminKeySeed);
  return void 0;
}
async function findEntry(config, typeIri) {
  await assertSafeFetchTarget(config.podUrl);
  const entries = await discover(config.podUrl, void 0, { fetch: guardedFetchFn(config.fetch ?? globalThis.fetch) });
  const localName = typeIri.split(/[#/]/).pop() ?? typeIri;
  const matching = entries.filter((e) => (e.conformsTo ?? []).some((c) => c === typeIri || c.split(/[#/]/).pop() === localName));
  if (matching.length === 0) return null;
  matching.sort((a, b) => (b.validFrom ?? "").localeCompare(a.validFrom ?? ""));
  return matching[0] ?? null;
}
async function fetchBundleJson(entry, config) {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const descRes = await safeFetch(entry.descriptorUrl, { headers: { "Accept": "text/turtle" } }, fetchFn);
  if (!descRes.ok) {
    throw new Error(`Failed to fetch descriptor ${entry.descriptorUrl}: ${descRes.status} ${descRes.statusText}`);
  }
  const descTurtle = await descRes.text();
  const graphUrl = extractDistributionTarget(descTurtle);
  if (!graphUrl) {
    throw new Error(`Descriptor ${entry.descriptorUrl} has no hydra:target / dcat:accessURL on its iep:affordance block`);
  }
  const adminKeyPair = resolveAdminKeyPair(config);
  const { content, encrypted } = await fetchGraphContent(graphUrl, {
    fetch: guardedFetchFn(fetchFn),
    ...adminKeyPair ? { recipientKeyPair: adminKeyPair } : {}
  });
  if (!content && encrypted) {
    throw new Error(`Graph at ${graphUrl} is encrypted and bridge has no recipient key (set FOXXI_ADMIN_KEY_SEED to decrypt admin sections)`);
  }
  if (!content) {
    throw new Error(`Graph at ${graphUrl} returned empty content`);
  }
  return extractBundleJson(content);
}
function extractDistributionTarget(descTurtle) {
  const targetMatch = descTurtle.match(/hydra:target\s+<([^>]+)>/);
  if (targetMatch?.[1]) return targetMatch[1];
  const accessMatch = descTurtle.match(/dcat:accessURL\s+<([^>]+)>/);
  if (accessMatch?.[1]) return accessMatch[1];
  return null;
}
function extractBundleJson(trig) {
  const m = trig.match(/<[^>]*#bundleJson>\s+"([A-Za-z0-9+/=\s]+)"/);
  if (!m?.[1]) {
    throw new Error("Graph body has no #bundleJson literal \u2014 not a tenant-publisher artifact?");
  }
  const b64 = m[1].replace(/\s+/g, "");
  let json;
  try {
    json = Buffer.from(b64, "base64").toString("utf8");
  } catch (err) {
    throw new Error(`Failed to base64-decode fxs:bundleJson: ${err.message}`);
  }
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new Error(`Failed to parse fxs:bundleJson payload as JSON: ${err.message}`);
  }
}
var SECTION_ABSENT_PREFIX = "No descriptor with conformsTo=";
async function fetchSection(typeIri, config) {
  const key = cacheKey(config.podUrl, config.authoritativeSource, typeIri);
  const hit = getCached(key);
  if (hit !== null) return hit;
  const entry = await findEntry(config, typeIri);
  if (!entry) {
    throw new Error(`${SECTION_ABSENT_PREFIX}${typeIri} found in pod ${config.podUrl}. Tenant publish required first.`);
  }
  const payload = await fetchBundleJson(entry, config);
  setCached(key, payload);
  return payload;
}

// ../interego-native88/trusted-native-maintenance-runtime.ts
init_src();
export {
  NativeCommitConflictError,
  NativeInteregoLrsDatabase,
  TENANT_TYPES,
  createConfiguredNativeLrsDatabase,
  createNativeByteArtifact,
  deriveAdminKeyPair,
  discover,
  fetchGraphContent,
  fetchSection,
  parseDistributionFromDescriptorTurtle,
  parseTrig,
  readNativeByteArtifact
};
/*! Bundled license information:

@noble/curves/utils.js:
@noble/curves/abstract/modular.js:
@noble/curves/abstract/curve.js:
@noble/curves/abstract/edwards.js:
@noble/curves/ed25519.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
