/**
 * @file        core/js/opcodes.js
 * @summary     Opcode tablosu: her komutun opcode'u, uzunluğu ve işlemciye etkisi.
 * @description Programın merkezindeki tablodur ve İKİ yerden kullanılır:
 *                - assembler.js (derleme): "MOV A,#05h" satırı için opcode'u buradan bulur → 74h.
 *                - emulator.js  (çözme):   flash'tan okunan 74h byte'ının hangi komut olduğunu buradan bulur.
 *              Yani opcode'u "oluşturan", bu tablodaki sabit değerdir; 8051 kullanıcı kılavuzundaki
 *              opcode haritasının bir parçasıdır.
 *
 *              Biçimlerdeki operand türleri ve makine kodunda kapladıkları byte sayısı:
 *                A, C, DPTR, @A+DPTR  → 0 byte (opcode'un içindedir)
 *                Rn (R0–R7)           → 0 byte; register numarası opcode'un son 3 bitidir (ör. MOV A,R3 = E8h + 3 = EBh)
 *                @Ri (@R0, @R1)       → 0 byte; i opcode'un son bitidir
 *                #data   → 1 byte sabit        #data16 → 2 byte sabit (önce yüksek byte)
 *                dir     → 1 byte adres (00h–7Fh RAM, 80h–FFh SFR)
 *                rel     → 1 byte işaretli ofset (−128…+127); hedef = sıradaki komutun adresi + ofset
 *                addr16  → 2 byte adres (önce yüksek byte)
 *
 *              Bu uygulama 8051 komut kümesinin öğretim için seçilmiş bir alt kümesini içerir.
 *
 * @author      Sercan Sebetçi <sercan.sebetci@ogr.sakarya.edu.tr>
 * @copyright   2026 Sercan Sebetçi
 * @license     MIT
 * @version     1.0.0 (2026-11-15)
 */

/**
 * Çözülmüş operand değerleri (decode() üretir, komutun run() fonksiyonu kullanır).
 * @typedef  {Object} Operands
 * @property {number} [n]       Rn register numarası (0–7).
 * @property {number} [i]       @Ri register numarası (0–1).
 * @property {number} [data]    #data değeri.
 * @property {number} [data16]  #data16 değeri.
 * @property {number} [dir]     Doğrudan adres.
 * @property {number} [rel]     Bağıl atlamanın HEDEF adresi.
 * @property {number} [off]     Bağıl ofset (−128…+127).
 * @property {number} [addr16]  16 bit hedef adres.
 */

/**
 * Opcode tablosunun bir satırı.
 * @typedef  {Object} OpcodeEntry
 * @property {number} opcode    Opcode byte'ı (00h–FFh).
 * @property {string} fmt       Biçim, ör. `"MOV A,Rn"`.
 * @property {string} mn        Komut adı, ör. `"MOV"`.
 * @property {string[]} kinds   Operand türleri, ör. `["A", "Rn"]`.
 * @property {number} len       Komutun toplam byte sayısı.
 * @property {number} [reg]     Rn / @Ri biçimlerinde opcode'a gömülü register numarası.
 * @property {function(Cpu, Operands): void} run  Komutun işlemciye etkisi.
 */

// === Stack yardımcıları (PUSH, POP, LCALL, RET kullanır) ===

/**
 * Stack'e bir byte atar: önce SP bir artar, sonra değer RAM[SP]'ye yazılır.
 * @param {Cpu} c
 * @param {number} v
 * @returns {void}
 */
function push(c, v) {
  const sp = (c.sfr[0x81] + 1) & 0xFF;
  writeDirect(c, 0x81, sp);
  writeDirect(c, sp, v);
}

/**
 * Stack'ten bir byte alır: önce RAM[SP] okunur, sonra SP bir azalır.
 * @param {Cpu} c
 * @returns {number}
 */
function pop(c) {
  const sp = c.sfr[0x81], v = readDirect(c, sp);
  c.log.push("RAM[" + hex2(sp) + "h] okunur (stack tepesi) = " + hex2(v) + "h");
  writeDirect(c, 0x81, (sp - 1) & 0xFF);
  return v;
}

/**
 * Program sayacını hedef adrese ayarlar (atlama) ve kaydeder.
 * @param {Cpu} c
 * @param {number} t - Hedef adres.
 * @returns {void}
 */
function jumpTo(c, t) {
  c.pc = t & 0xFFFF;
  c.changed.pc = true;
  c.log.push("PC ← " + hex4(c.pc) + "h (atlama)");
}

/**
 * A ← A + v + cy; CY, AC ve OV bayraklarını ayarlar (ADD ve ADDC).
 * @param {Cpu} c
 * @param {number} v
 * @param {number} cy
 * @returns {void}
 */
function addA(c, v, cy) {
  const a = getA(c), r = a + v + cy;
  setFlag(c, 7, r > 0xFF);
  setFlag(c, 6, (a & 0x0F) + (v & 0x0F) + cy > 0x0F);
  setFlag(c, 2, ((a ^ r) & (v ^ r) & 0x80) !== 0);
  setA(c, r);
}

/**
 * A ← A − v − CY; CY (borç), AC ve OV bayraklarını ayarlar (SUBB).
 * @param {Cpu} c
 * @param {number} v
 * @returns {void}
 */
function subbA(c, v) {
  const a = getA(c), cy = getCY(c), r = a - v - cy;
  setFlag(c, 7, r < 0);
  setFlag(c, 6, (a & 0x0F) - (v & 0x0F) - cy < 0);
  setFlag(c, 2, ((a ^ v) & (a ^ r) & 0x80) !== 0);
  setA(c, r);
}

/**
 * Koşullu bağıl atlama: koşul doğruysa hedefe atlar; sonucu kaydeder.
 * @param {Cpu} c
 * @param {boolean} cond
 * @param {number} target
 * @returns {void}
 */
function jumpIf(c, cond, target) {
  c.log.push("Koşul " + (cond ? "DOĞRU → atlanır" : "YANLIŞ → atlanmaz, sıradaki komuta geçilir"));
  if (cond) jumpTo(c, target);
}

// === Komut biçimleri ===
// Her satır: [biçim, temel opcode, işlemciye etkisi]. Rn biçimleri 8, @Ri biçimleri 2 opcode'a açılır.

/**
 * Desteklenen komut biçimleri.
 * @type {Array<Array>}
 */
const FORMATS = [
  // Veri transferi
  ["MOV A,#data",    0x74, (c, o) => setA(c, o.data)],
  ["MOV A,Rn",       0xE8, (c, o) => setA(c, readDirect(c, rAddr(c, o.n)))],
  ["MOV A,dir",      0xE5, (c, o) => setA(c, readDirect(c, o.dir))],
  ["MOV A,@Ri",      0xE6, (c, o) => setA(c, readDirect(c, readDirect(c, rAddr(c, o.i)) & 0x7F))],
  ["MOV Rn,#data",   0x78, (c, o) => writeDirect(c, rAddr(c, o.n), o.data)],
  ["MOV Rn,A",       0xF8, (c, o) => writeDirect(c, rAddr(c, o.n), getA(c))],
  ["MOV Rn,dir",     0xA8, (c, o) => writeDirect(c, rAddr(c, o.n), readDirect(c, o.dir))],
  ["MOV dir,A",      0xF5, (c, o) => writeDirect(c, o.dir, getA(c))],
  ["MOV dir,#data",  0x75, (c, o) => writeDirect(c, o.dir, o.data)],
  ["MOV dir,Rn",     0x88, (c, o) => writeDirect(c, o.dir, readDirect(c, rAddr(c, o.n)))],
  ["MOV @Ri,A",      0xF6, (c, o) => writeDirect(c, readDirect(c, rAddr(c, o.i)) & 0x7F, getA(c))],
  ["MOV @Ri,#data",  0x76, (c, o) => writeDirect(c, readDirect(c, rAddr(c, o.i)) & 0x7F, o.data)],
  ["MOV DPTR,#data16", 0x90, (c, o) => { writeDirect(c, 0x83, o.data16 >> 8); writeDirect(c, 0x82, o.data16); }],
  ["PUSH dir",       0xC0, (c, o) => push(c, readDirect(c, o.dir))],
  ["POP dir",        0xD0, (c, o) => writeDirect(c, o.dir, pop(c))],
  // Aritmetik ve mantık
  ["ADD A,#data",    0x24, (c, o) => addA(c, o.data, 0)],
  ["ADD A,Rn",       0x28, (c, o) => addA(c, readDirect(c, rAddr(c, o.n)), 0)],
  ["ADD A,dir",      0x25, (c, o) => addA(c, readDirect(c, o.dir), 0)],
  ["ADDC A,#data",   0x34, (c, o) => addA(c, o.data, getCY(c))],
  ["SUBB A,#data",   0x94, (c, o) => subbA(c, o.data)],
  ["SUBB A,Rn",      0x98, (c, o) => subbA(c, readDirect(c, rAddr(c, o.n)))],
  ["INC A",          0x04, c => setA(c, getA(c) + 1)],
  ["INC Rn",         0x08, (c, o) => writeDirect(c, rAddr(c, o.n), readDirect(c, rAddr(c, o.n)) + 1)],
  ["INC dir",        0x05, (c, o) => writeDirect(c, o.dir, readDirect(c, o.dir) + 1)],
  ["DEC A",          0x14, c => setA(c, getA(c) - 1)],
  ["DEC Rn",         0x18, (c, o) => writeDirect(c, rAddr(c, o.n), readDirect(c, rAddr(c, o.n)) - 1)],
  ["ANL A,#data",    0x54, (c, o) => setA(c, getA(c) & o.data)],
  ["ORL A,#data",    0x44, (c, o) => setA(c, getA(c) | o.data)],
  ["XRL A,#data",    0x64, (c, o) => setA(c, getA(c) ^ o.data)],
  ["CLR A",          0xE4, c => setA(c, 0)],
  ["CPL A",          0xF4, c => setA(c, ~getA(c))],
  ["RL A",           0x23, c => setA(c, (getA(c) << 1) | (getA(c) >> 7))],
  ["RR A",           0x03, c => setA(c, (getA(c) >> 1) | (getA(c) << 7))],
  ["CLR C",          0xC3, c => setFlag(c, 7, 0)],
  ["SETB C",         0xD3, c => setFlag(c, 7, 1)],
  // Dallanma
  ["LJMP addr16",    0x02, (c, o) => jumpTo(c, o.addr16)],
  ["SJMP rel",       0x80, (c, o) => jumpTo(c, o.rel)],
  ["JZ rel",         0x60, (c, o) => jumpIf(c, getA(c) === 0, o.rel)],
  ["JNZ rel",        0x70, (c, o) => jumpIf(c, getA(c) !== 0, o.rel)],
  ["JC rel",         0x40, (c, o) => jumpIf(c, getCY(c) === 1, o.rel)],
  ["JNC rel",        0x50, (c, o) => jumpIf(c, getCY(c) === 0, o.rel)],
  ["DJNZ Rn,rel",    0xD8, (c, o) => { const a = rAddr(c, o.n); writeDirect(c, a, readDirect(c, a) - 1); jumpIf(c, readDirect(c, a) !== 0, o.rel); }],
  ["CJNE A,#data,rel", 0xB4, (c, o) => { setFlag(c, 7, getA(c) < o.data); jumpIf(c, getA(c) !== o.data, o.rel); }],
  ["LCALL addr16",   0x12, (c, o) => { c.log.push("Dönüş adresi = " + hex4(c.pc) + "h (PC, getirme sırasında zaten sıradaki komutu gösteriyor)"); push(c, c.pc & 0xFF); push(c, c.pc >> 8); jumpTo(c, o.addr16); }],
  ["RET",            0x22, c => { const hi = pop(c), lo = pop(c); c.log.push("Dönüş adresi = PCH:PCL = " + hex2(hi) + hex2(lo) + "h"); jumpTo(c, (hi << 8) | lo); }],
  ["NOP",            0x00, () => {}]   // hiçbir şey yapmaz
];

/** Operand türü → makine kodunda kapladığı byte sayısı. @type {Object<string, number>} */
const OPERAND_BYTES = { "#data": 1, "#data16": 2, dir: 1, rel: 1, addr16: 2 };

/**
 * Opcode tablosu: indeks = opcode byte'ı. Tabloda olmayan opcode'lar `undefined`'dır.
 * @type {OpcodeEntry[]}
 */
const OPCODE_TABLE = new Array(256);

// Tabloyu biçimlerden kur: Rn biçimi 8 opcode'a (op+0 … op+7), @Ri biçimi 2 opcode'a açılır
FORMATS.forEach(([fmt, op, run]) => {
  const sp = fmt.indexOf(" ");
  const mn = sp < 0 ? fmt : fmt.slice(0, sp);
  const kinds = sp < 0 ? [] : fmt.slice(sp + 1).split(",");
  const len = 1 + kinds.reduce((s, k) => s + (OPERAND_BYTES[k] || 0), 0);
  const count = kinds.includes("Rn") ? 8 : kinds.includes("@Ri") ? 2 : 1;
  for (let r = 0; r < count; r++) {
    OPCODE_TABLE[op + r] = { opcode: op + r, fmt, mn, kinds, len, reg: count > 1 ? r : undefined, run };
  }
});
