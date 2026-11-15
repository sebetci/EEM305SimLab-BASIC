/**
 * @file        core/js/emulator.js
 * @summary     Emülatör: makine kodunu flash'a yükler ve komutları GETİR → ÇÖZ → YÜRÜT döngüsüyle işletir.
 * @description Ekrandaki düğmeler bu dosyadaki fonksiyonları çağırır:
 *
 *                | Düğme          | Fonksiyon         | Ne yapar                                                    |
 *                |----------------|-------------------|-------------------------------------------------------------|
 *                | Flash'a Yükle  | {@link loadProgram} | Assembler'ın ürettiği byte'ları flash'a (program belleği) yazar |
 *                | Reset          | {@link resetCpu}  | PC = 0000h, SP = 07h … (8051 reset durumu)                   |
 *                | 1 · Getir      | {@link fetch}     | flash[PC] → IR; her okunan byte için PC ← PC + 1             |
 *                | 2 · Çöz        | {@link decode}    | IR'deki opcode → opcode tablosu → komut ve operandlar        |
 *                | 3 · Yürüt      | {@link execute}   | Komutun etkisi: register / RAM / bayrak / PC değişir         |
 *
 *              Önemli: emülatör assembler'ın listesine BAKMAZ. Komutu yalnızca flash'taki byte'lardan
 *              ve opcode tablosundan anlar; gerçek bir 8051 de böyle çalışır.
 *
 * @author      Sercan Sebetçi <sercan.sebetci@ogr.sakarya.edu.tr>
 * @copyright   2026 Sercan Sebetçi
 * @license     MIT
 * @version     1.0.0 (2026-11-15)
 */

/**
 * Her aşamanın başında işlem kayıtlarını temizler.
 * @param {Cpu} c
 * @returns {void}
 */
function beginStage(c) {
  c.log = [];
  c.changed = {};
}

/**
 * Assembler'ın ürettiği makine kodunu flash'a yazar. Önce bütün flash FFh (boş) yapılır.
 * @param {Cpu} c
 * @param {ListingLine[]} listing - assemble() sonucundaki liste.
 * @returns {void}
 */
function loadProgram(c, listing) {
  beginStage(c);
  c.flash.fill(0xFF);
  listing.forEach(row => row.bytes.forEach((b, i) => {
    const a = (row.addr + i) & 0xFFFF;
    c.flash[a] = b;
    c.changed["flash" + a] = true;
  }));
  const n = listing.reduce((s, r) => s + r.bytes.length, 0);
  c.log.push(n + " byte makine kodu flash'a yazıldı. Boş hücreler FFh'dir.");
}

/**
 * 8051 reset durumu. Flash'a dokunmaz (program bellekte kalır).
 * @param {Cpu} c
 * @returns {void}
 */
function resetCpu(c) {
  beginStage(c);
  c.pc = 0x0000;
  c.ram.fill(0);
  Object.keys(c.sfr).forEach(a => { c.sfr[a] = 0; });
  c.sfr[0x81] = 0x07;                                          // SP
  [0x80, 0x90, 0xA0, 0xB0].forEach(a => { c.sfr[a] = 0xFF; });  // P0–P3
  c.ir = []; c.irAddr = 0; c.decoded = null;
  c.log.push("PC ← 0000h: işlemci programa her zaman 0000h adresinden başlar.");
  c.log.push("SP ← 07h, P0–P3 ← FFh, A, B, PSW, DPTR ← 00h.");
  c.log.push("RAM bu uygulamada 00h ile doldurulur (gerçek işlemcide içeriği belirsizdir).");
}

/**
 * 1 · GETİR: PC'nin gösterdiği adresten komutu okur ve IR'ye koyar.
 *  - Önce opcode byte'ı okunur: IR ← flash[PC], PC ← PC + 1.
 *  - Opcode tablosundan komutun kaç byte olduğu öğrenilir; kalan byte'lar da aynı şekilde okunur
 *    ve her okumada PC bir artar.
 * Getirme bittiğinde PC, BİR SONRAKİ komutun adresini gösterir.
 * @param {Cpu} c
 * @returns {void}
 * @throws {string} Opcode tabloda yoksa (ör. boş flash FFh) hata.
 */
function fetch(c) {
  beginStage(c);
  c.irAddr = c.pc;
  c.decoded = null;
  const opcode = c.flash[c.pc];
  c.ir = [opcode];
  c.log.push("IR ← flash[" + hex4(c.pc) + "h] = " + hex2(opcode) + "h (opcode)");
  c.pc = (c.pc + 1) & 0xFFFF;
  c.log.push("PC ← PC + 1 = " + hex4(c.pc) + "h");
  const entry = OPCODE_TABLE[opcode];
  if (!entry) throw "Opcode " + hex2(opcode) + "h bu uygulamanın opcode tablosunda yok" + (opcode === 0xFF ? " (FFh: flash'ın boş hücresi; program buraya kadar gelmemeliydi)" : "") + ".";
  if (entry.len > 1) c.log.push("Opcode tablosuna göre bu komut " + entry.len + " byte; kalan " + (entry.len - 1) + " byte da okunur:");
  for (let k = 1; k < entry.len; k++) {
    const b = c.flash[c.pc];
    c.ir.push(b);
    c.log.push("IR ← flash[" + hex4(c.pc) + "h] = " + hex2(b) + "h,  PC ← " + hex4(c.pc + 1) + "h");
    c.pc = (c.pc + 1) & 0xFFFF;
  }
  c.changed.pc = true;
  c.changed.ir = true;
}

/**
 * 2 · ÇÖZ: IR'deki opcode'u opcode tablosunda bulur ve operand byte'larını anlamlandırır.
 * Sonuç `c.decoded`'a yazılır: komut satırı (entry), operand değerleri (o) ve okunabilir metin.
 * @param {Cpu} c
 * @returns {void}
 */
function decode(c) {
  beginStage(c);
  const entry = OPCODE_TABLE[c.ir[0]], o = {};
  c.log.push("Opcode " + hex2(entry.opcode) + "h (" + bin8(entry.opcode) + ") → opcode tablosu: " + entry.fmt + ", " + entry.len + " byte");
  let k = 1;
  entry.kinds.forEach(kind => {
    if (kind === "Rn") { o.n = entry.reg; c.log.push("Rn: register numarası opcode'un son 3 bitinde → R" + o.n + " (RAM " + hex2(rAddr(c, o.n)) + "h)"); }
    else if (kind === "@Ri") { o.i = entry.reg; c.log.push("@Ri: opcode'un son biti → @R" + o.i); }
    else if (kind === "#data") { o.data = c.ir[k++]; c.log.push("#data = " + hex2(o.data) + "h (2. byte)"); }
    else if (kind === "#data16") { o.data16 = (c.ir[k] << 8) | c.ir[k + 1]; k += 2; c.log.push("#data16 = " + hex4(o.data16) + "h"); }
    else if (kind === "dir") { o.dir = c.ir[k++]; c.log.push("dir = " + hex2(o.dir) + "h → " + (o.dir < 0x80 ? "RAM adresi" : "SFR " + sfrName(o.dir))); }
    else if (kind === "rel") {
      const b = c.ir[k++];
      o.off = b > 127 ? b - 256 : b;                 // işaretli 8 bit: 80h–FFh negatiftir
      o.rel = (c.pc + o.off) & 0xFFFF;               // PC zaten sıradaki komutu gösteriyor
      c.log.push("rel = " + hex2(b) + "h = " + o.off + " → hedef = PC + rel = " + hex4(c.pc) + "h + (" + o.off + ") = " + hex4(o.rel) + "h");
    }
    else if (kind === "addr16") { o.addr16 = (c.ir[k] << 8) | c.ir[k + 1]; k += 2; c.log.push("addr16 = " + hex4(o.addr16) + "h"); }
  });
  c.decoded = { entry, o, text: instructionText(entry, o) };
  c.log.push("Çözülen komut: " + c.decoded.text);
}

/**
 * 3 · YÜRÜT: Çözülen komutun işlemciye etkisini uygular (opcodes.js'teki run fonksiyonu).
 * Ardından parite bayrağı güncellenir.
 * @param {Cpu} c
 * @returns {boolean} Program sona erdiyse (`SJMP $`, kendine atlama) `true`.
 */
function execute(c) {
  beginStage(c);
  const { entry, o } = c.decoded;
  entry.run(c, o);
  updateParity(c);
  if (!c.log.length) c.log.push("Bu komut hiçbir register'ı ya da bellek hücresini değiştirmez.");
  const halted = c.pc === c.irAddr && entry.mn === "SJMP";
  if (halted) c.log.push("Komut kendi adresine atlıyor: programın sonu (SJMP $).");
  return halted;
}

/**
 * Çözülmüş komutun okunabilir metni (ör. "MOV A,#05h", "DJNZ R7,0032h").
 * @param {OpcodeEntry} entry
 * @param {Operands} o
 * @returns {string}
 */
function instructionText(entry, o) {
  const parts = entry.kinds.map(k => ({
    Rn: "R" + o.n, "@Ri": "@R" + o.i, "#data": "#" + hex2(o.data) + "h", "#data16": "#" + hex4(o.data16) + "h",
    dir: o.dir >= 0x80 ? sfrName(o.dir) : hex2(o.dir) + "h", rel: hex4(o.rel) + "h", addr16: hex4(o.addr16) + "h"
  })[k] || k);
  return entry.mn + (parts.length ? " " + parts.join(",") : "");
}

/**
 * "Geri" için işlemcinin anlık kopyasını alır. Flash değişmediği için kopyalanmaz.
 * @param {Cpu} c
 * @returns {Object}
 */
function snapshot(c) {
  return { ram: c.ram.slice(), sfr: { ...c.sfr }, pc: c.pc, ir: c.ir.slice(), irAddr: c.irAddr, decoded: c.decoded, log: c.log.slice(), changed: { ...c.changed } };
}

/**
 * Bir kopyayı işlemciye geri yükler.
 * @param {Cpu} c
 * @param {Object} s - {@link snapshot} sonucu.
 * @returns {void}
 */
function restore(c, s) {
  c.ram.set(s.ram); c.sfr = { ...s.sfr }; c.pc = s.pc; c.ir = s.ir.slice(); c.irAddr = s.irAddr;
  c.decoded = s.decoded; c.log = s.log.slice(); c.changed = { ...s.changed };
}
