import * as iconv from 'iconv-lite';
import jschardet from 'jschardet';

// Character encodings. The body of a diff is decoded with an encoding decided per file.

export interface EncodingPrefs {
  /** files.encoding of VS Code (per resource) */
  encoding: string;
  /** files.autoGuessEncoding of VS Code */
  autoGuess: boolean;
  /** UI language (vscode.env.language). For Japanese, Shift_JIS and EUC-JP are tried first when guessing */
  language?: string;
}

/** Convert a files.encoding value to an iconv-lite name */
const VSCODE_TO_ICONV: Record<string, string> = {
  utf8: 'utf8',
  utf8bom: 'utf8',
  utf16le: 'utf16le',
  utf16be: 'utf16be',
  windows1252: 'windows-1252',
  iso88591: 'iso-8859-1',
  shiftjis: 'shift_jis',
  eucjp: 'euc-jp',
  iso2022jp: 'iso-2022-jp',
  gbk: 'gbk',
  gb18030: 'gb18030',
  big5hkscs: 'big5-hkscs',
  euckr: 'euc-kr',
  windows1251: 'windows-1251',
  koi8r: 'koi8-r',
  cp866: 'cp866',
  cp437: 'cp437',
  cp850: 'cp850',
};

export function toIconvName(vscodeEncoding: string): string {
  const name = VSCODE_TO_ICONV[vscodeEncoding.toLowerCase()] ?? vscodeEncoding;
  return iconv.encodingExists(name) ? name : 'utf8';
}

/** Display name (shown in the diff header) */
export function displayName(iconvName: string): string {
  switch (iconvName.toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return 'UTF-8';
    case 'shift_jis':
    case 'sjis':
    case 'windows-31j':
    case 'cp932':
      return 'Shift_JIS';
    case 'euc-jp':
      return 'EUC-JP';
    default:
      return iconvName.toUpperCase();
  }
}

export function isValidUtf8(buf: Buffer): boolean {
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    let need: number;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else return false;
    if (i + need >= n) return false;
    for (let k = 1; k <= need; k++) {
      if ((buf[i + k] & 0xc0) !== 0x80) return false;
    }
    i += need + 1;
  }
  return true;
}

const JSCHARDET_TO_ICONV: Record<string, string> = {
  SHIFT_JIS: 'shift_jis',
  'EUC-JP': 'euc-jp',
  'ISO-2022-JP': 'iso-2022-jp',
  'UTF-8': 'utf8',
  ascii: 'utf8',
  'windows-1252': 'windows-1252',
  'ISO-8859-1': 'iso-8859-1',
  'EUC-KR': 'euc-kr',
  Big5: 'big5',
  GB2312: 'gb18030',
  'UTF-16LE': 'utf16le',
  'UTF-16BE': 'utf16be',
  'windows-1251': 'windows-1251',
  'KOI8-R': 'koi8-r',
};

/**
 * Decide the encoding from the bytes of the lines in a diff.
 * If autoGuess is on: UTF-8 if the bytes are valid UTF-8, otherwise a guess.
 * If it is off, follow files.encoding.
 */
export function chooseEncoding(sample: Buffer, prefs: EncodingPrefs): string {
  const configured = toIconvName(prefs.encoding || 'utf8');
  if (!prefs.autoGuess) return configured;
  if (isValidUtf8(sample)) return 'utf8';
  // jschardet tends to take short Japanese text for a Western encoding.
  // In a Japanese environment, first check whether the bytes are structurally valid Shift_JIS or EUC-JP
  if (prefs.language?.toLowerCase().startsWith('ja')) {
    const ja = guessJapanese(sample);
    if (ja) return ja;
  }
  try {
    const binary = sample.toString('binary');
    // Short text is easily misdetected as a Western encoding, so narrow the guess to CJK encodings first
    const cjk = jschardet.detect(binary, { minimumThreshold: 0.6, detectEncodings: CJK_ENCODINGS });
    const guess = cjk?.encoding ? cjk : jschardet.detect(binary, { minimumThreshold: 0.2 });
    const mapped = guess?.encoding ? JSCHARDET_TO_ICONV[guess.encoding] : undefined;
    if (mapped && iconv.encodingExists(mapped)) return mapped;
  } catch {
    /* If guessing fails, use the configured value */
  }
  return configured;
}

const CJK_ENCODINGS = ['SHIFT_JIS', 'EUC-JP', 'ISO-2022-JP', 'GB2312', 'Big5', 'EUC-KR'];

/** The name if the bytes contain double-byte characters and every byte is valid as EUC-JP or Shift_JIS */
export function guessJapanese(buf: Buffer): 'euc-jp' | 'shift_jis' | undefined {
  // EUC-JP is stricter (an EUC-JP string can also be read as Shift_JIS half-width katakana), so check it first
  let eucPairs = 0;
  let eucOk = true;
  for (let i = 0; i < buf.length && eucOk; i++) {
    const b = buf[i];
    if (b < 0x80) continue;
    if (b === 0x8e) {
      const c = buf[i + 1];
      if (c === undefined || c < 0xa1 || c > 0xdf) eucOk = false;
      i += 1;
    } else if (b === 0x8f) {
      const c = buf[i + 1];
      const d = buf[i + 2];
      if (c === undefined || d === undefined || c < 0xa1 || c > 0xfe || d < 0xa1 || d > 0xfe) eucOk = false;
      i += 2;
      eucPairs++;
    } else if (b >= 0xa1 && b <= 0xfe) {
      const c = buf[i + 1];
      if (c === undefined || c < 0xa1 || c > 0xfe) eucOk = false;
      i += 1;
      eucPairs++;
    } else {
      eucOk = false;
    }
  }
  if (eucOk && eucPairs > 0) return 'euc-jp';

  let sjisPairs = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x80 || (b >= 0xa1 && b <= 0xdf)) continue;
    if ((b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc)) {
      const c = buf[i + 1];
      if (c === undefined || c < 0x40 || c === 0x7f || c > 0xfc) return undefined;
      i += 1;
      sjisPairs++;
      continue;
    }
    return undefined;
  }
  return sjisPairs > 0 ? 'shift_jis' : undefined;
}

export function decode(buf: Buffer, iconvName: string): string {
  if (iconvName === 'utf8') return buf.toString('utf8');
  return iconv.decode(buf, iconvName);
}
