/**
 * @file        core/js/cpu.js
 * @summary     İşlemcinin (CPU) parçaları: program belleği (flash), dahili RAM, SFR'ler, PC ve IR.
 * @description Bu dosya yalnızca işlemcinin "durumunu" tutar ve ona erişen küçük fonksiyonlar sağlar.
 *              Hiçbir komutu kendisi işletmez; komutları emulator.js işletir.
 *
 *              8051 bellek düzeni (bu uygulamada modellenen kısmı):
 *                - Flash (program belleği): 0000h–FFFFh, 64 KB. Programın makine kodu burada durur.
 *                - Dahili RAM: 00h–7Fh, 128 byte. R0–R7 register'ları RAM'in 00h–07h adresleridir (bank 0).
 *                - SFR (özel fonksiyon register'ları): 80h–FFh. A, B, PSW, SP, DPTR ve portlar buradadır.
 *                - PC (program sayacı): 16 bit; SFR değildir, adresi yoktur.
 *
 * @author      Sercan Sebetçi <sercan.sebetci@ogr.sakarya.edu.tr>
 * @copyright   2026 Sercan Sebetçi
 * @license     MIT
 * @version     1.0.0 (2026-11-15)
 */

/**
 * Bu uygulamada kullanılan SFR'ler: ad → doğrudan (direct) adres.
 * Assembler, kaynak kodda geçen `P1`, `ACC` gibi adları bu tabloyla adrese çevirir.
 * @type {Object<string, number>}
 */
const SFR_ADDR = { P0: 0x80, SP: 0x81, DPL: 0x82, DPH: 0x83, P1: 0x90, P2: 0xA0, P3: 0xB0, PSW: 0xD0, ACC: 0xE0, B: 0xF0 };

/**
 * İşlemcinin durumu.
 * @typedef  {Object} Cpu
 * @property {Uint8Array} flash     64 KB program belleği.
 * @property {Uint8Array} ram       128 byte dahili RAM (00h–7Fh).
 * @property {Object<number, number>} sfr  SFR alanı: adres → değer.
 * @property {number} pc            Program sayacı: sıradaki okunacak byte'ın flash adresi.
 * @property {number[]} ir          Komut register'ı (IR): getirilen komutun byte'ları.
 * @property {number} irAddr        Getirilen komutun flash adresi.
 * @property {?Object} decoded      Çözülmüş komut (decode() sonucu).
 * @property {string[]} log         Son aşamada yapılan işlemlerin açıklamaları.
 * @property {Object<string, boolean>} changed  Son aşamada değişen yerler (ekranda vurgulamak için).
 */

/**
 * Boş bir işlemci oluşturur. Flash'ın programlanmamış hücreleri FFh'dir (gerçek flash'ta da öyledir).
 * @returns {Cpu}
 */
function createCpu() {
  const c = { flash: new Uint8Array(65536).fill(0xFF), ram: new Uint8Array(128), sfr: {}, pc: 0, ir: [], irAddr: 0, decoded: null, log: [], changed: {} };
  Object.values(SFR_ADDR).forEach(a => { c.sfr[a] = 0; });
  return c;
}

// === Register ve bellek erişimi ===
// Komutlar işlemciye yalnızca bu fonksiyonlarla dokunur. Her yazma, "ne değişti" listesine (c.log)
// ve vurgulanacak yerlere (c.changed) kaydedilir.

/** Akümülatörün (A, SFR E0h) değeri. @param {Cpu} c @returns {number} */
const getA = c => c.sfr[0xE0];

/**
 * Akümülatöre yazar.
 * @param {Cpu} c
 * @param {number} v - Yeni değer (8 bite kırpılır).
 * @returns {void}
 */
const setA = (c, v) => writeDirect(c, 0xE0, v);

/**
 * Doğrudan (direct) adresten okur: 00h–7Fh RAM, 80h–FFh SFR.
 * @param {Cpu} c
 * @param {number} a - Adres.
 * @returns {number}
 */
function readDirect(c, a) {
  return a < 0x80 ? c.ram[a] : (c.sfr[a] ?? 0);
}

/**
 * Doğrudan (direct) adrese yazar ve değişikliği kaydeder.
 * @param {Cpu} c
 * @param {number} a - Adres (00h–FFh).
 * @param {number} v - Değer (8 bite kırpılır).
 * @returns {void}
 */
function writeDirect(c, a, v) {
  v &= 0xFF;
  if (a < 0x80) {
    c.ram[a] = v;
    c.changed["ram" + a] = true;
    c.log.push("RAM[" + hex2(a) + "h] ← " + hex2(v) + "h");
  } else {
    c.sfr[a] = v;
    c.changed["sfr" + a] = true;
    c.log.push(sfrName(a) + " (" + hex2(a) + "h) ← " + hex2(v) + "h");
  }
}

/**
 * Aktif register bankının RAM'deki başlangıç adresi (PSW.4:PSW.3 → 00h, 08h, 10h, 18h).
 * @param {Cpu} c
 * @returns {number}
 */
const bankBase = c => ((c.sfr[0xD0] >> 3) & 3) * 8;

/**
 * Rn register'ının RAM adresi.
 * @param {Cpu} c
 * @param {number} n - 0–7.
 * @returns {number}
 */
const rAddr = (c, n) => bankBase(c) + n;

/**
 * Elde bayrağı CY (PSW.7).
 * @param {Cpu} c
 * @returns {number} 0 ya da 1.
 */
const getCY = c => (c.sfr[0xD0] >> 7) & 1;

/**
 * PSW'nin bir bitini ayarlar ve kaydeder.
 * @param {Cpu} c
 * @param {number} bit - 7 = CY, 6 = AC, 2 = OV, 0 = P.
 * @param {number|boolean} v - Yeni değer.
 * @returns {void}
 */
function setFlag(c, bit, v) {
  const old = c.sfr[0xD0], neu = v ? old | (1 << bit) : old & ~(1 << bit);
  if (old !== neu) {
    c.sfr[0xD0] = neu;
    c.changed["sfr" + 0xD0] = true;
    c.log.push({ 7: "CY", 6: "AC", 2: "OV", 0: "P" }[bit] + " bayrağı ← " + (v ? 1 : 0));
  }
}

/**
 * Parite bayrağını (P = PSW.0) A'ya göre günceller: A'daki 1 bitlerinin sayısı tekse P = 1.
 * 8051'de bu donanım tarafından sürekli yapılır; burada her komuttan sonra çağrılır.
 * @param {Cpu} c
 * @returns {void}
 */
function updateParity(c) {
  let a = getA(c), p = 0;
  while (a) { p ^= a & 1; a >>= 1; }
  setFlag(c, 0, p);
}

// === Yardımcılar ===

/** Sayı → 2 haneli hex metin. @param {number} n @returns {string} */
const hex2 = n => (n & 0xFF).toString(16).toUpperCase().padStart(2, "0");

/** Sayı → 4 haneli hex metin. @param {number} n @returns {string} */
const hex4 = n => (n & 0xFFFF).toString(16).toUpperCase().padStart(4, "0");

/** Byte → 8 haneli ikilik metin ("0111 0100"). @param {number} n @returns {string} */
const bin8 = n => (n & 0xFF).toString(2).padStart(8, "0").replace(/(\d{4})(\d{4})/, "$1 $2");

/**
 * SFR adresinin adı (ör. E0h → "A"); bilinmiyorsa hex adres.
 * @param {number} a
 * @returns {string}
 */
function sfrName(a) {
  const k = Object.keys(SFR_ADDR).find(n => SFR_ADDR[n] === a);
  return k === "ACC" ? "A" : (k || hex2(a) + "h");
}
