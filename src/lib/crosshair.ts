// Crosshair model shared by the crosshair generator page (#/crosshair) and the tools page.
// Encoding/decoding of share codes is done by csgo-sharecode (MIT, akiver), which supports
// the `CS…` format of the 30.09.2026 update and the older `CSGO-…` codes.
//
// Since the 23.09.2026 update CS2 sizes are whole pixels at `screenHeight` (the game rescales
// them when the resolution changes). Old values are converted with the formulas published in
// the README of JDD310/CS2-Crosshair-Converter (verified there on Classic Static at 1080p/960p):
//   scale = height / 480; length = round(size × scale); thickness = max(1, round(thickness × scale));
//   gap = trunc(4 + gap) + ceil(thickness / 2)   (the old gap was not resolution scaled)
import {
  crosshairToConVars,
  decodeCrosshairShareCode,
  encodeCrosshair,
  type Crosshair,
  type CrosshairLegacyV1,
  type CrosshairV1,
} from 'csgo-sharecode';

export type XH = CrosshairV1;
/** console-only settings that are not part of the share code */
export type Extras = { sniperWidth: number };
export const DEFAULT_EXTRAS: Extras = { sniperWidth: 1 };

export type StyleKind = 'cross' | 'circle' | 'dot' | 'quad' | 'square';
export type StyleInfo = { id: number; en: string; ru: string; kind: StyleKind; dynamic?: boolean; split?: boolean; feedback?: boolean; approx?: boolean; hint: string };

export const STYLES: StyleInfo[] = [
  { id: 0, en: 'Dynamic Cross', ru: 'Динамический крест', kind: 'cross', dynamic: true, hint: 'Линии расходятся вместе с реальным разбросом оружия при движении и стрельбе.' },
  { id: 1, en: 'Dynamic Circle', ru: 'Динамический круг', kind: 'circle', dynamic: true, approx: true, hint: 'Кольцо, радиус которого показывает текущий разброс. Зазор — радиус в покое, толщина — ширина кольца.' },
  { id: 2, en: 'Dynamic Cross (Legacy)', ru: 'Динамический крест (Legacy)', kind: 'cross', dynamic: true, split: true, hint: 'Классический динамический прицел: при разбросе линии делятся на внутренние и внешние. Единственный стиль, где работает отрицательный зазор.' },
  { id: 3, en: 'Static Circle', ru: 'Статичный круг', kind: 'circle', approx: true, hint: 'Неподвижное кольцо: зазор — радиус, толщина — ширина линии.' },
  { id: 4, en: 'Static Cross', ru: 'Статичный крест', kind: 'cross', hint: 'Классический неподвижный крест — выбор большинства профи.' },
  { id: 5, en: 'Static Cross (Shot Feedback)', ru: 'Статичный крест с откликом на выстрел', kind: 'cross', feedback: true, hint: 'Неподвижный крест, который коротко раскрывается в момент выстрела.' },
  { id: 6, en: 'Dot Only', ru: 'Только точка', kind: 'dot', hint: 'Одна точка, её размер задаёт толщина.' },
  { id: 7, en: 'Dynamic Quad', ru: 'Динамический квад', kind: 'quad', dynamic: true, approx: true, hint: 'Стиль по умолчанию: неподвижный крест плюс внешний слой из четырёх элементов, который раскрывается с разбросом.' },
  { id: 8, en: 'Static Square', ru: 'Статичный квадрат', kind: 'square', approx: true, hint: 'Квадратная рамка вокруг цели: зазор — размер, толщина — ширина линий.' },
  { id: 9, en: 'Static Quad', ru: 'Статичный квад', kind: 'quad', approx: true, hint: 'Четыре неподвижные дуги. Зазор — расстояние до центра, «доля длины» — размер дуг.' },
];
export const styleInfo = (id: number): StyleInfo => STYLES[id] || STYLES[4];

/** CS2 defaults after the September 2026 update (Dynamic Quad, 8/2/4 px at 1080p, full outline) */
export const DEFAULT_XH: XH = {
  format: 'cs2-v1', style: 7, followRecoil: true, centerDotEnabled: false, tStyleEnabled: false, outlineMode: 1,
  red: 0, green: 255, blue: 0, alpha: 255, outlineRed: 0, outlineGreen: 0, outlineBlue: 0, outlineAlpha: 255,
  gap: 4, length: 8, thickness: 2, dynamicSpreadLimit: 255, splitDistance: 3, innerSplitAlpha: 0, outerSplitAlpha: 1,
  splitSizeRatio: 1, screenHeight: 1080, scopeDotScale: 1, scopeDotUseCrosshairColor: false,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r2 = (v: number) => Math.round(v * 100) / 100;

/** fills missing fields and clamps everything to the ranges of the cs2-v1 code */
export function sanitize(x: Partial<XH> | null | undefined): XH {
  const a: any = x || {};
  const d = DEFAULT_XH;
  const i = (k: keyof XH, lo: number, hi: number) => Math.round(clamp(num(a[k], d[k] as number), lo, hi));
  const f = (k: keyof XH, lo: number, hi: number) => r2(clamp(num(a[k], d[k] as number), lo, hi));
  const b = (k: keyof XH) => (typeof a[k] === 'boolean' ? a[k] : (d[k] as boolean));
  return {
    format: 'cs2-v1',
    style: i('style', 0, 9), followRecoil: b('followRecoil'), centerDotEnabled: b('centerDotEnabled'), tStyleEnabled: b('tStyleEnabled'),
    outlineMode: i('outlineMode', 0, 2),
    red: i('red', 0, 255), green: i('green', 0, 255), blue: i('blue', 0, 255), alpha: i('alpha', 0, 255),
    outlineRed: i('outlineRed', 0, 255), outlineGreen: i('outlineGreen', 0, 255), outlineBlue: i('outlineBlue', 0, 255), outlineAlpha: i('outlineAlpha', 0, 255),
    gap: i('gap', -3840, 3840), length: i('length', 0, 255), thickness: i('thickness', 0, 32),
    dynamicSpreadLimit: i('dynamicSpreadLimit', 0, 255), splitDistance: i('splitDistance', 0, 127),
    innerSplitAlpha: f('innerSplitAlpha', 0, 1), outerSplitAlpha: f('outerSplitAlpha', 0.3, 1), splitSizeRatio: f('splitSizeRatio', 0, 1),
    screenHeight: i('screenHeight', 240, 65535), scopeDotScale: f('scopeDotScale', 0.1, 2), scopeDotUseCrosshairColor: b('scopeDotUseCrosshairColor'),
  };
}

export const encode = (ch: XH): string => {
  try { return encodeCrosshair(sanitize(ch)); } catch { return ''; }
};

/** console commands, one per line (ConVar names of the cs2-v1 format) */
export function commandLines(ch: XH, ex?: Extras): string[] {
  let lines: string[] = [];
  try { lines = crosshairToConVars(sanitize(ch)).trim().split('\n').map((l) => l.trim()).filter(Boolean); } catch {}
  if (ex) lines.push(`cl_crosshair_sniper_width "${ex.sniperWidth}"`);
  return lines;
}
export const commandsOneLine = (ch: XH, ex?: Extras) => commandLines(ch, ex).join('; ');
export function autoexec(ch: XH, ex: Extras): string {
  return [
    '// Прицел CS2 — собран в генераторе прицела RUSH B',
    `// Код для импорта в игре: ${encode(ch)}`,
    '',
    ...commandLines(ch, ex),
    '',
    'echo "autoexec: crosshair loaded"',
    '',
  ].join('\n');
}

/** rescales the pixel values to another reference screen height (what CS2 does on a resolution change) */
export function rescale(ch: XH, height: number): XH {
  const k = height / Math.max(1, ch.screenHeight);
  const px = (v: number) => Math.round(v * k);
  return sanitize({
    ...ch, screenHeight: height, length: px(ch.length), gap: px(ch.gap),
    thickness: ch.thickness > 0 ? Math.max(1, px(ch.thickness)) : 0,
    dynamicSpreadLimit: px(ch.dynamicSpreadLimit), splitDistance: px(ch.splitDistance),
  });
}

// ---------- old values -> pixels ----------

/** round half to even, like the reference converter */
export function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(v);
}
/** cl_crosshaircolor 0–4 of CS:GO / old CS2 */
export const OLD_COLORS: [number, number, number][] = [[250, 50, 50], [50, 250, 50], [250, 250, 50], [50, 50, 250], [50, 250, 250]];
const OLD_COLOR_NAMES = ['красный', 'зелёный', 'жёлтый', 'синий', 'голубой'];
/** old style numbers (CS:GO and CS2 before 23.09.2026) to the new ones */
export const mapOldStyle = (s: number) => (s === 4 ? 4 : s === 5 ? 5 : 2);

type OldValues = {
  size?: number; thickness?: number; gap?: number; style?: number; alpha?: number; useAlpha?: boolean; color?: number;
  r?: number; g?: number; b?: number; outline?: boolean; outlineThickness?: number; dot?: boolean; t?: boolean; recoil?: boolean;
  splitDist?: number; inner?: number; outer?: number; ratio?: number; fixedGap?: boolean; weaponGap?: boolean;
};

/** applies old-style values (CS:GO units) on top of `base`, converting them to pixels at `height` */
function applyOld(base: XH, o: OldValues, height: number, notes: string[]): XH {
  const ch: XH = { ...rescale(base, height) };
  const scale = height / 480;
  if (o.size != null) ch.length = clamp(roundHalfEven(o.size * scale), 0, 255);
  if (o.thickness != null) ch.thickness = clamp(Math.max(1, roundHalfEven(o.thickness * scale)), 1, 32);
  if (o.style != null) ch.style = mapOldStyle(o.style);
  if (o.gap != null) ch.gap = Math.trunc(4 + o.gap) + Math.ceil(ch.thickness / 2);
  if (o.r != null) ch.red = clamp(Math.round(o.r), 0, 255);
  if (o.g != null) ch.green = clamp(Math.round(o.g), 0, 255);
  if (o.b != null) ch.blue = clamp(Math.round(o.b), 0, 255);
  if (o.color != null && o.color >= 0 && o.color <= 4) {
    [ch.red, ch.green, ch.blue] = OLD_COLORS[o.color];
    notes.push(`Цвет cl_crosshaircolor ${o.color} (${OLD_COLOR_NAMES[o.color]}) переведён в RGB — в новом CS2 пресетов цвета нет.`);
  }
  if (o.alpha != null) ch.alpha = clamp(Math.round(o.alpha), 0, 255);
  if (o.useAlpha === false) ch.alpha = 255;
  if (o.outline != null) ch.outlineMode = o.outline ? 1 : 0;
  if (o.outlineThickness != null && o.outlineThickness !== 1) notes.push(`Толщина обводки ${o.outlineThickness} больше не настраивается: обводка теперь всегда 1 px (можно выбрать «половину»).`);
  if (o.dot != null) ch.centerDotEnabled = o.dot;
  if (o.t != null) ch.tStyleEnabled = o.t;
  if (o.recoil != null) ch.followRecoil = o.recoil;
  if (o.splitDist != null) ch.splitDistance = clamp(Math.round(o.splitDist), 0, 127);
  if (o.inner != null) ch.innerSplitAlpha = r2(clamp(o.inner, 0, 1));
  if (o.outer != null) ch.outerSplitAlpha = r2(clamp(o.outer, 0.3, 1));
  if (o.ratio != null) ch.splitSizeRatio = r2(clamp(o.ratio, 0, 1));
  if (o.fixedGap || o.weaponGap) notes.push('cl_fixedcrosshairgap и cl_crosshairgap_useweaponvalue удалены из игры — пропущены.');
  if (o.style != null && o.style !== 4) notes.push(`Старый стиль ${o.style} → «${styleInfo(ch.style).en}» (ближайший аналог, проверьте в игре).`);
  if (ch.gap < 0 && ch.style !== 2) {
    notes.push(`Зазор получился ${ch.gap}: отрицательный зазор работает только у Dynamic Cross (Legacy), поэтому поставлен 0 (крест закрыт).`);
    ch.gap = 0;
  }
  notes.unshift(`Старые значения переведены в пиксели для высоты экрана ${height} px: размер × ${height}/480, зазор = 4 + gap + половина толщины.`);
  return sanitize(ch);
}

function fromCode(c: Crosshair, height: number, notes: string[]): XH {
  if (c.format === 'cs2-v1') return sanitize(c);
  if (c.format === 'legacy-v1') {
    const o = c as CrosshairLegacyV1;
    return applyOld(DEFAULT_XH, {
      size: o.length, thickness: o.thickness, gap: o.gap, style: o.style, alpha: o.alpha, useAlpha: o.alphaEnabled,
      color: o.color, r: o.red, g: o.green, b: o.blue, outline: o.outlineEnabled, outlineThickness: o.outline,
      dot: o.centerDotEnabled, t: o.tStyleEnabled, recoil: o.followRecoil, splitDist: o.splitDistance,
      inner: o.innerSplitAlpha, outer: o.outerSplitAlpha, ratio: o.splitSizeRatio,
    }, height, notes);
  }
  // legacy-v3 / legacy-v4: already pixels, same field meaning
  const a: any = c;
  notes.push('Код промежуточного формата 23–29.09.2026: значения уже в пикселях, добавлены цвет обводки и настройки точки оптики по умолчанию.');
  return sanitize({ ...DEFAULT_XH, ...a, format: 'cs2-v1', outlineMode: a.outlineMode ?? (a.outlineEnabled ? 1 : 0) });
}

// ---------- import ----------

const DICT = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';
const NEW_CODE = new RegExp(`CS[${DICT}]{44}(?![${DICT}])`);
const OLD_CODE = new RegExp(`CSGO(?:-[${DICT}]{5}){5}`);

export type ImportOk = { ok: true; ch: XH; extras?: Partial<Extras>; kind: string; notes: string[] };
export type ImportResult = ImportOk | { ok: false; error: string };

const FORMAT_LABEL: Record<string, string> = {
  'cs2-v1': 'Код CS2 нового формата (с 30.09.2026)',
  'legacy-v4': 'Код CSGO-… версии 4 (24–29.09.2026) — переведён в новый формат',
  'legacy-v3': 'Код CSGO-… версии 3 (23.09.2026) — переведён в новый формат',
  'legacy-v1': 'Старый код CSGO-… (до 23.09.2026) — пересчитан в пиксели',
};

export function decodeCode(code: string, height: number): ImportResult {
  const notes: string[] = [];
  try {
    const c = decodeCrosshairShareCode(code.trim());
    return { ok: true, ch: fromCode(c, height, notes), kind: FORMAT_LABEL[c.format] || c.format, notes };
  } catch {
    return { ok: false, error: 'Код не распознан: проверьте, что он скопирован целиком. Новый формат — «CS» и 44 символа, старый — CSGO-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX.' };
  }
}

const NEW_VARS: Record<string, [keyof XH, 'i' | 'f' | 'b']> = {
  cl_crosshair_length: ['length', 'i'], cl_crosshair_thickness: ['thickness', 'i'], cl_crosshair_gap: ['gap', 'i'],
  cl_crosshairdot: ['centerDotEnabled', 'b'], cl_crosshair_t: ['tStyleEnabled', 'b'], cl_crosshair_recoil: ['followRecoil', 'b'],
  cl_crosshair_drawoutline: ['outlineMode', 'i'],
  cl_crosshaircolor_r: ['red', 'i'], cl_crosshaircolor_g: ['green', 'i'], cl_crosshaircolor_b: ['blue', 'i'], cl_crosshaircolor_a: ['alpha', 'i'],
  cl_crosshairoutline_r: ['outlineRed', 'i'], cl_crosshairoutline_g: ['outlineGreen', 'i'], cl_crosshairoutline_b: ['outlineBlue', 'i'], cl_crosshairoutline_a: ['outlineAlpha', 'i'],
  cl_crosshair_dynamic_spread_limit: ['dynamicSpreadLimit', 'i'], cl_crosshair_dynamic_splitdist: ['splitDistance', 'i'],
  cl_crosshair_dynamic_splitalpha_innermod: ['innerSplitAlpha', 'f'], cl_crosshair_dynamic_splitalpha_outermod: ['outerSplitAlpha', 'f'],
  cl_crosshair_dynamic_maxdist_splitratio: ['splitSizeRatio', 'f'], cl_crosshair_screen_height: ['screenHeight', 'i'],
  cl_ironsight_dot_scale: ['scopeDotScale', 'f'], cl_ironsight_usecrosshaircolor: ['scopeDotUseCrosshairColor', 'b'],
};
const OLD_ONLY = ['cl_crosshairsize', 'cl_crosshairthickness', 'cl_crosshairgap', 'cl_crosshairalpha', 'cl_crosshairusealpha', 'cl_crosshaircolor', 'cl_crosshair_outlinethickness', 'cl_fixedcrosshairgap', 'cl_crosshairgap_useweaponvalue'];
const NO_EFFECT = ['crosshair', 'cl_crosshair_friendly_warning', 'cl_crosshair_sniper_show_normal_inaccuracy', 'cl_crosshairscale', 'cl_crosshair_drawoutline_mode'];

/** splits a block of console text into [name, value] pairs */
export function tokenizeCommands(text: string): [string, string][] {
  const out: [string, string][] = [];
  const src = text.replace(/\/\/[^\n]*/g, '').replace(/\s+(?=(?:cl_|apply_crosshair_code)\w*)/gi, ';');
  for (const raw of src.split(/[;\n\r]+/)) {
    const m = raw.trim().match(/^([A-Za-z_][\w.]*)\s*(?:"([^"]*)"?|(\S+))?/);
    if (m) out.push([m[1].toLowerCase(), (m[2] ?? m[3] ?? '').trim()]);
  }
  return out;
}

/** parses console commands (new or old names) on top of `base`; old values are converted at `height` */
export function parseCommands(text: string, base: XH, height: number): ImportResult {
  const pairs = tokenizeCommands(text);
  const codeCmd = pairs.find(([k]) => k === 'apply_crosshair_code');
  if (codeCmd && codeCmd[1]) return decodeCode(codeCmd[1], height);
  const map = new Map<string, string>();
  for (const [k, v] of pairs) map.set(k, v);
  const unknown: string[] = [];
  const ignored: string[] = [];
  let recognized = 0;
  for (const k of map.keys()) {
    if (k in NEW_VARS || OLD_ONLY.includes(k) || k === 'cl_crosshairstyle' || k === 'cl_crosshair_sniper_width') recognized++;
    else if (NO_EFFECT.includes(k)) ignored.push(k);
    else unknown.push(k);
  }
  if (!recognized) return { ok: false, error: 'Не нашёл ни кода прицела, ни команд cl_crosshair…. Вставьте код CS…/CSGO-… или команды вида cl_crosshair_length 3; cl_crosshair_gap 1.' };
  const notes: string[] = [];
  const val = (k: string) => {
    const v = parseFloat(map.get(k) ?? '');
    return Number.isFinite(v) ? v : undefined;
  };
  const isOld = ['cl_crosshairsize', 'cl_crosshairthickness', 'cl_crosshairgap', 'cl_crosshairalpha', 'cl_crosshaircolor'].some((k) => map.has(k));
  let ch: XH = { ...base };
  if (isOld) {
    const b = (k: string) => (val(k) == null ? undefined : val(k) !== 0);
    ch = applyOld(base, {
      size: val('cl_crosshairsize'), thickness: val('cl_crosshairthickness'), gap: val('cl_crosshairgap'), style: val('cl_crosshairstyle'),
      alpha: val('cl_crosshairalpha'), useAlpha: b('cl_crosshairusealpha'), color: val('cl_crosshaircolor'),
      outlineThickness: val('cl_crosshair_outlinethickness'), fixedGap: map.has('cl_fixedcrosshairgap'), weaponGap: map.has('cl_crosshairgap_useweaponvalue'),
    }, height, notes);
  } else if (val('cl_crosshairstyle') != null) {
    ch.style = val('cl_crosshairstyle')!;
  }
  // old configs always carry r/g/b, but the game used them only with cl_crosshaircolor 5
  const oldPreset = isOld && val('cl_crosshaircolor') != null && val('cl_crosshaircolor') !== 5;
  for (const [k, [field, t]] of Object.entries(NEW_VARS)) {
    const v = val(k);
    if (v == null) continue;
    if (isOld && k === 'cl_crosshair_screen_height') continue;
    if (oldPreset && /^cl_crosshaircolor_[rgb]$/.test(k)) continue;
    (ch as any)[field] = t === 'b' ? v !== 0 : t === 'i' ? Math.round(v) : v;
  }
  const extras: Partial<Extras> = {};
  const sw = val('cl_crosshair_sniper_width');
  if (sw != null) extras.sniperWidth = clamp(Math.round(sw), 0, 20);
  ch = sanitize(ch);
  if (!isOld && ch.gap < 0 && ch.style !== 2) notes.push('Отрицательный зазор CS2 применяет только к Dynamic Cross (Legacy) — у этого стиля он будет как 0.');
  if (ignored.length) notes.push(`Не влияют на код прицела: ${ignored.join(', ')}.`);
  if (unknown.length) notes.push(`Не распознаны: ${unknown.slice(0, 8).join(', ')}${unknown.length > 8 ? '…' : ''}.`);
  if (pairs.length && recognized < 6) notes.push('Не указанные параметры оставлены как были.');
  return { ok: true, ch, extras, kind: isOld ? 'Команды консоли старого формата (cl_crosshairsize …)' : 'Команды консоли', notes };
}

/** detects a share code (new or old) or a block of console commands */
export function importAny(text: string, base: XH, height: number): ImportResult {
  const t = text.trim();
  if (!t) return { ok: false, error: 'Вставьте код или команды.' };
  const hasVars = /\bcl_[a-z_]+/i.test(t);
  if (!hasVars) {
    const m = t.match(OLD_CODE) || t.match(NEW_CODE);
    if (m) return decodeCode(m[0], height);
    if (/^CS/i.test(t)) return decodeCode(t, height);
  }
  return parseCommands(t, base, height);
}

// ---------- presets, pros, random ----------

const mk = (p: Partial<XH>): XH => sanitize({ ...DEFAULT_XH, followRecoil: false, ...p });
export type Preset = { name: string; note: string; ch: XH };
export const PRESETS: Preset[] = [
  { name: 'Стандарт CS2', note: 'Dynamic Quad, как в игре по умолчанию', ch: sanitize(DEFAULT_XH) },
  { name: 'Маленький крест', note: 'Аналог старого size 2 / gap −3', ch: mk({ style: 4, length: 4, thickness: 1, gap: 2, outlineMode: 1 }) },
  { name: 'Компактный плюс', note: 'Короткие линии без обводки', ch: mk({ style: 4, length: 3, thickness: 2, gap: 1, outlineMode: 0, red: 255, green: 255, blue: 0 }) },
  { name: 'Крест с точкой', note: 'Белый, с обводкой', ch: mk({ style: 4, length: 6, thickness: 2, gap: 4, centerDotEnabled: true, red: 255, green: 255, blue: 255 }) },
  { name: 'T-образный', note: 'Без верхней линии', ch: mk({ style: 4, length: 6, thickness: 2, gap: 3, tStyleEnabled: true, red: 255, green: 0, blue: 255 }) },
  { name: 'Точка', note: 'Только точка 4 px', ch: mk({ style: 6, thickness: 4, red: 0, green: 255, blue: 255 }) },
  { name: 'Динамический', note: 'С разделением линий, как в CS:GO', ch: mk({ style: 2, length: 7, thickness: 1, gap: 3, splitDistance: 7, innerSplitAlpha: 1, outerSplitAlpha: 0.5, splitSizeRatio: 0.35, followRecoil: true }) },
  { name: 'Круг с точкой', note: 'Static Circle', ch: mk({ style: 3, gap: 7, thickness: 2, centerDotEnabled: true, red: 0, green: 255, blue: 255 }) },
  { name: 'Квадрат', note: 'Static Square', ch: mk({ style: 8, gap: 5, thickness: 1, centerDotEnabled: true }) },
];

export type Pro = { name: string; team: string; code: string; source: string; seen: string };
/** Codes taken from crosshair.club player pages (settings read from match demos), checked on PROS_CHECKED:
 *  each code decodes with csgo-sharecode and matches the console commands shown on the same page. */
export const PROS_CHECKED = '05.11.2026';
export const PROS: Pro[] = [
  { name: 'donk', team: 'Spirit', code: 'CSFSeRKbPTW9uokYFQjqyiTGZLZWWqUxLALJc8dHV5bq8E', source: 'https://crosshair.club/players/donk', seen: '04.11.2026' },
  { name: 'ZywOo', team: 'Vitality', code: 'CS6bn6bJeOmmd35ur7m83TdDtmCPucSTUjz3hSNuwJMiyE', source: 'https://crosshair.club/players/zywoo', seen: '31.10.2026' },
  { name: 'm0NESY', team: 'Falcons', code: 'CSTjicTWjkYkq965ihXB93bXUvSvjir5DhaCXW2NcwOAYF', source: 'https://crosshair.club/players/m0nesy', seen: '04.11.2026' },
  { name: 'b1t', team: 'Natus Vincere', code: 'CSiuObDzWBiXvWXr8UJU5TLsmhBNMJMBaH5AjAS63CFNqF', source: 'https://crosshair.club/players/b1t', seen: '04.11.2026' },
];

export const SWATCHES: { ru: string; rgb: [number, number, number] }[] = [
  { ru: 'Зелёный', rgb: [0, 255, 0] },
  { ru: 'Жёлтый', rgb: [255, 255, 0] },
  { ru: 'Голубой', rgb: [0, 255, 255] },
  { ru: 'Розовый', rgb: [255, 0, 255] },
  { ru: 'Белый', rgb: [255, 255, 255] },
  { ru: 'Красный', rgb: [255, 0, 0] },
  ...OLD_COLORS.map((rgb, i) => ({ ru: `Старый cl_crosshaircolor ${i} (${OLD_COLOR_NAMES[i]})`, rgb })),
];

export function randomXH(height: number, rnd: () => number = Math.random): XH {
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const style = pick([4, 4, 4, 4, 5, 0, 2, 6, 7, 3, 8, 9]);
  const colors: [number, number, number][] = [[0, 255, 0], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 255, 255], [255, 0, 0], [int(0, 255), int(0, 255), int(0, 255)]];
  const [red, green, blue] = pick(colors);
  return rescale(sanitize({
    ...DEFAULT_XH, style, red, green, blue,
    length: style === 6 ? 4 : int(1, 10), thickness: int(1, style === 6 ? 5 : 3), gap: style === 2 ? int(-2, 5) : int(0, style === 3 || style === 9 ? 9 : 5),
    outlineMode: pick([0, 1, 1, 2]), alpha: pick([255, 255, 255, int(160, 255)]),
    centerDotEnabled: style !== 6 && rnd() < 0.25, tStyleEnabled: style !== 6 && rnd() < 0.15, followRecoil: rnd() < 0.5,
    splitDistance: int(2, 8), innerSplitAlpha: r2(rnd()), outerSplitAlpha: r2(0.3 + rnd() * 0.7), splitSizeRatio: r2(rnd()),
  }), height);
}
