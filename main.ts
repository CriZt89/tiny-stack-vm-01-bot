// Tiny stack VM, ISA v1 (see kit ISA.md). Runs every /input/iNNN program and
// writes its answer to /output/iNNN. My own implementation from the spec:
// 32-bit wrapping ints, 256-value stack, 64-deep call stack, 256 words of
// memory, ten traps, 1,000,000 step limit, 65,536 output limit.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const OUTLIM = 65536;
const STEPLIM = 1000000;

// Run one program on its input. Returns [stdout bytes, exit code].
function run(prog, input) {
  const n = prog.length;
  const st = new Int32Array(256);
  let sp = 0;
  const cs = new Int32Array(64);
  let cp = 0;
  const mem = new Int32Array(256);
  const out = new Uint8Array(OUTLIM);
  let ol = 0;
  let ip = 0;
  let steps = 0;
  let pos = 0;
  const end = (code) => [out.slice(0, ol), code];
  for (;;) {
    if (steps === STEPLIM) return end(10);
    if (ip < 0 || ip >= n) return end(9);
    const op = prog[ip];
    const ok =
      op <= 7 ||
      (op >= 16 && op <= 34) ||
      (op >= 48 && op <= 52) ||
      (op >= 64 && op <= 65) ||
      (op >= 80 && op <= 83);
    if (!ok) return end(5);
    const imm = op === 1 ? 1 : op === 2 ? 4 : op >= 48 && op <= 51 ? 2 : 0;
    if (ip + imm >= n) return end(9);
    steps++;
    const nx = ip + 1 + imm;
    ip = nx;
    switch (op) {
      case 0x00:
        return end(0);
      case 0x01: // PUSH8, sign-extended
        if (sp === 256) return end(3);
        st[sp++] = (prog[nx - 1] << 24) >> 24;
        break;
      case 0x02: // PUSH32, little-endian signed
        if (sp === 256) return end(3);
        st[sp++] =
          prog[nx - 4] |
          (prog[nx - 3] << 8) |
          (prog[nx - 2] << 16) |
          (prog[nx - 1] << 24);
        break;
      case 0x03: // POP
        if (sp < 1) return end(2);
        sp--;
        break;
      case 0x04: // DUP
        if (sp < 1) return end(2);
        if (sp === 256) return end(3);
        st[sp] = st[sp - 1];
        sp++;
        break;
      case 0x05: // SWAP
        if (sp < 2) return end(2);
        {
          const t = st[sp - 1];
          st[sp - 1] = st[sp - 2];
          st[sp - 2] = t;
        }
        break;
      case 0x06: // OVER
        if (sp < 2) return end(2);
        if (sp === 256) return end(3);
        st[sp] = st[sp - 2];
        sp++;
        break;
      case 0x07: // ROT
        if (sp < 3) return end(2);
        {
          const t = st[sp - 3];
          st[sp - 3] = st[sp - 2];
          st[sp - 2] = st[sp - 1];
          st[sp - 1] = t;
        }
        break;
      case 0x17: // NEG
        if (sp < 1) return end(2);
        st[sp - 1] = -st[sp - 1] | 0;
        break;
      case 0x1b: // NOT
        if (sp < 1) return end(2);
        st[sp - 1] = ~st[sp - 1];
        break;
      case 0x30: // JMP
      case 0x31: // JZ
      case 0x32: // JNZ
      {
        const rel = ((prog[nx - 2] | (prog[nx - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) {
          if (sp < 1) return end(2);
          const v = st[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) ip = nx + rel;
        break;
      }
      case 0x33: // CALL
        if (cp === 64) return end(7);
        cs[cp++] = nx;
        ip = prog[nx - 2] | (prog[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return end(8);
        ip = cs[--cp];
        break;
      case 0x40: {
        // LOAD
        if (sp < 1) return end(2);
        const a = st[sp - 1];
        if (a < 0 || a >= 256) return end(6);
        st[sp - 1] = mem[a];
        break;
      }
      case 0x41: {
        // STORE
        if (sp < 2) return end(2);
        const a = st[sp - 1];
        const v = st[sp - 2];
        if (a < 0 || a >= 256) return end(6);
        sp -= 2;
        mem[a] = v;
        break;
      }
      case 0x50: {
        // PRINT: decimal ASCII, no newline
        if (sp < 1) return end(2);
        const s = String(st[sp - 1]);
        if (ol + s.length > OUTLIM) return end(11);
        sp--;
        for (let i = 0; i < s.length; i++) out[ol++] = s.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC
        if (sp < 1) return end(2);
        if (ol + 1 > OUTLIM) return end(11);
        out[ol++] = st[--sp] & 255;
        break;
      case 0x52: // IN: -1 once the input is used up
        if (sp === 256) return end(3);
        st[sp++] = pos < input.length ? input[pos++] : -1;
        break;
      case 0x53: // EXIT: low byte is the code
        if (sp < 1) return end(2);
        return end(st[--sp] & 255);
      default: {
        // Binary ops: ADD SUB MUL DIV MOD DIVU MODU AND OR XOR
        // SHL SHR SHRU EQ LT LTU. b is the top, a below it.
        if (sp < 2) return end(2);
        const b = st[sp - 1];
        const a = st[sp - 2];
        let r;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (op === 0x13) {
          if (b === 0) return end(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 0x14) {
          if (b === 0) return end(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 0x15) {
          if (b === 0) return end(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 0x16) {
          if (b === 0) return end(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU
        st[sp - 2] = r;
        sp--;
        break;
      }
    }
  }
}

for (let k = 1; k <= 40; k++) {
  const id = "i" + String(k).padStart(3, "0");
  let ob = new Uint8Array(0);
  let ex = 0;
  try {
    const prog = readFileSync("/input/" + id + "/program.bin");
    const input = readFileSync("/input/" + id + "/input.bin");
    [ob, ex] = run(prog, input);
  } catch {
    // A failed instance still gets a well-formed (if wrong) answer.
  }
  mkdirSync("/output/" + id, { recursive: true });
  writeFileSync("/output/" + id + "/stdout.bin", ob);
  writeFileSync("/output/" + id + "/exit.txt", String(ex));
}
