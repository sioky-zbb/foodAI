'use strict';

/* ============ 工具 ============ */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function num(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, digits = 1) {
  const factor = Math.pow(10, digits);
  return Math.round(num(value) * factor) / factor;
}

function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const DAY_META = [
  { key: 'sun', label: '周日' },
  { key: 'mon', label: '周一' },
  { key: 'tue', label: '周二' },
  { key: 'wed', label: '周三' },
  { key: 'thu', label: '周四' },
  { key: 'fri', label: '周五' },
  { key: 'sat', label: '周六' }
];

function dayMetaForDate(dateStr) {
  const d = new Date(String(dateStr || localDateString()) + 'T00:00:00');
  return DAY_META[d.getDay()];
}

function targetsForDate(dateStr) {
  if (settings.useWeekTargets) {
    const wk = settings.weekTargets[dayMetaForDate(dateStr).key];
    if (wk) return wk;
  }
  return settings.targets;
}

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/* ============ 本地设置 ============ */
const DEFAULT_SETTINGS = {
  glmKey: '',
  glmModel: 'glm-4.6v-flash',
  glmUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  dsKey: '',
  dsModel: 'deepseek-v4-flash',
  dsUrl: 'https://api.deepseek.com/chat/completions',
  refCard: { type: 'none', len: 11.2, wid: 6.8 },
  targets: { calories: 1800, protein: 120, carbs: 180, fat: 60 },
  useWeekTargets: false,
  weekTargets: {
    mon: { calories: 1800, protein: 120, carbs: 180, fat: 60 },
    tue: { calories: 1800, protein: 120, carbs: 180, fat: 60 },
    wed: { calories: 1800, protein: 120, carbs: 180, fat: 60 },
    thu: { calories: 1800, protein: 120, carbs: 180, fat: 60 },
    fri: { calories: 1800, protein: 120, carbs: 180, fat: 60 },
    sat: { calories: 1800, protein: 120, carbs: 180, fat: 60 },
    sun: { calories: 1800, protein: 120, carbs: 180, fat: 60 }
  },
  user: { weight: '', height: '' },
  plan: ''
};

function loadSettings() {
  try {
    const raw = localStorage.getItem('foodlens_settings');
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    const saved = JSON.parse(raw);
    return Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), saved);
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

function saveSettings() {
  localStorage.setItem('foodlens_settings', JSON.stringify(settings));
}

let settings = loadSettings();
let weightRefs = [];

/* ============ IndexedDB ============ */
let _dbPromise = null;

function idb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('foodlens', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meals')) db.createObjectStore('meals', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('body')) db.createObjectStore('body', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('customFoods')) db.createObjectStore('customFoods', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return _dbPromise;
}

async function idbAll(storeName) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(storeName, record) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName, id) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ============ API 调用 ============ */
function parseJsonCandidates(candidates) {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    try { return JSON.parse(candidate); } catch (e) { /* 尝试下一个候选 */ }
  }
  return null;
}

function balancedBlock(source, start, open, close) {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function extractJson(text) {
  const source = String(text || '').replace(/```(?:json)?/gi, '').trim();
  // 优先解析完整对象
  const braceStart = source.indexOf('{');
  if (braceStart !== -1) {
    const parsed = parseJsonCandidates([balancedBlock(source, braceStart, '{', '}')]);
    if (parsed) return parsed;
    // 容错修复：公测模型偶尔把对象结尾的 } 输出成 ]
    const tail = source.slice(braceStart).replace(/\]\s*$/, '}');
    const lastClose = source.lastIndexOf('}');
    const closedBlock = lastClose > braceStart ? source.slice(braceStart, lastClose + 1) : null;
    const repaired = parseJsonCandidates([tail, closedBlock]);
    if (repaired) return repaired;
  }
  const arrayStart = source.indexOf('[');
  if (arrayStart !== -1) {
    const parsed = parseJsonCandidates([balancedBlock(source, arrayStart, '[', ']')]);
    if (parsed) return parsed;
  }
  return null;
}

function cleanModelOutput(content) {
  let text = String(content == null ? '' : content);
  if (text.includes('<answer>')) {
    const start = text.indexOf('<answer>') + '<answer>'.length;
    const end = text.indexOf('</answer>', start);
    if (end !== -1) text = text.slice(start, end);
  }
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return text;
}

async function apiChat(url, key, model, messages, options = {}) {
  const payload = {
    model,
    messages,
    max_tokens: options.maxTokens || 1600
  };
  if (options.thinking) payload.thinking = { type: 'enabled' };
  if (options.jsonMode) payload.response_format = { type: 'json_object' };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = (body && (body.error && body.error.message)) || JSON.stringify(body).slice(0, 200);
    } catch (e) { /* ignore */ }
    const error = new Error(`HTTP ${response.status}: ${detail}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : '';
  return cleanModelOutput(content);
}

function glmModelChain() {
  const models = [settings.glmModel, 'glm-4.1v-thinking-flash', 'glm-4v-flash'];
  return Array.from(new Set(models.filter(Boolean)));
}

async function glmVision(messages, options = {}) {
  const models = options.models || glmModelChain();
  let lastError = null;
  for (const model of models) {
    const maxTokens = model === 'glm-4v-flash'
      ? Math.min(options.maxTokens || 1400, 1024)
      : (options.maxTokens || 1400);
    try {
      return await apiChat(settings.glmUrl, settings.glmKey, model, messages, Object.assign({}, options, { maxTokens }));
    } catch (error) {
      lastError = error;
      if (error.status === 429) await sleep(2500);
      // 继续尝试下一个可用模型
    }
  }
  throw lastError || new Error('GLM 调用失败');
}

async function analyzerChat(messages, options = {}) {
  if (settings.dsKey) {
    const models = Array.from(new Set([settings.dsModel, 'deepseek-chat'].filter(Boolean)));
    let lastError = null;
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const text = await apiChat(settings.dsUrl, settings.dsKey, model, messages, Object.assign({ maxTokens: 4096, jsonMode: true }, options));
          if (!String(text || '').trim()) {
            throw Object.assign(new Error('DeepSeek 返回内容为空'), { status: 429 });
          }
          return text;
        } catch (error) {
          lastError = error;
          if (error.status === 429) await sleep(3000);
          // 空内容/限流/异常都继续尝试下一个模型
        }
      }
    }
    throw lastError;
  }
  return glmVision(messages, Object.assign({ maxTokens: 2048 }, options));
}

/* ============ 图片处理 ============ */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

function imageToDataURL(img, maxDim, quality) {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

async function fileToDataURL(file, maxDim = 1280, quality = 0.85) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    return imageToDataURL(img, maxDim, quality);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/* ============ 提示词 ============ */
function visionPrompt() {
  const ref = settings.refCard;
  let refLine = '';
  if (ref.type === 'idcard') {
    refLine = '画面中有一张身份证或银行卡（标准尺寸长8.5cm、宽5.4cm），请把它当作比例尺，据此估算每个食物的实际尺寸（cm）。';
  } else if (ref.type === 'custom') {
    const len = num(ref.len) || 11.2;
    const wid = num(ref.wid) || 6.8;
    refLine = `画面中有一张卡片（长${len}cm、宽${wid}cm，尺寸指卡片本体，不含挂扣/挂绳等附件），请以卡片本体的边缘和四角为测量基准，忽略凸出的挂扣；如果挂扣遮挡了长边，请改用短边宽度${wid}cm 作基准。`;
  }
  return `你是食物识别助手。请仔细查看这张图片，识别图中所有食物和饮品。${refLine}请务必逐一列出画面中所有食物和饮品，不要遗漏（包括主食、菜肴、配菜、小食、饮品），每一样单独输出一项。如果食物有包装（袋/盒/瓶/罐），请仔细阅读包装上的净含量/规格文字（如"净含量275克"、"15个"、"每100克营养成分"），原样写入 unit_text，net_weight_g 填总净含量（克），count 填规格总数，visible_count 填画面中可见的数量；看不清或没有包装则 package_info 为 null。如果卡片有明显透视角度、边缘被遮挡或没有出现卡片，请在 scene 中注明"参照卡缺失/有角度，估重可能不准"。对每一项输出：名称、大致份量（如一碗、半盘、一只、一杯）、可见的烹饪方式和主要食材、估算尺寸（长宽高或直径，单位cm）。如果图片中没有食物，输出 foods 为空数组。只描述你确实看到的内容，不要编造。严格按以下 JSON 格式输出（不要输出其他文字）：
{"foods":[{"name":"食物名称","portion":"大致份量","cooking":"烹饪方式","ingredients":"可见食材","size_cm":"约长8cm×宽5cm×高3cm","package_info":{"net_weight_g":0,"count":0,"unit_text":"包装规格原文","visible_count":0}}],"scene":"场景描述"}`;
}

const NUTRITION_PROMPT = `你是营养标签读取助手。请仔细阅读这张营养成分表图片，提取每100克（或每份）的能量/热量（kcal）、蛋白质（g）、碳水化合物（g）、脂肪（g）。如果表上标注的是"每份"数值，请同时识别每份重量（克），并换算成每100克的数值。只输出以下 JSON（不要输出其他文字）：
{"serving_size_g": 0, "per100": {"calories_kcal": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0}}`;

function normalizeFoodName(text) {
  return String(text || '').toLowerCase().replace(/[\s（）()·\-_/\\,，。、]/g, '');
}

function foodMatchScore(query, candidate) {
  const q = normalizeFoodName(query);
  const c = normalizeFoodName(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.includes(q) || q.includes(c)) return 85;
  if (q.length < 2 || c.length < 2) return 0;
  // 字符按序出现（模糊子序列）
  let pos = 0;
  let matched = 0;
  for (const ch of q) {
    const idx = c.indexOf(ch, pos);
    if (idx === -1) break;
    pos = idx + 1;
    matched++;
  }
  if (matched === q.length) {
    const ratio = q.length / c.length;
    if (ratio >= 0.5) return Math.round(50 + ratio * 20);
  }
  // 字符集合重叠度
  const qSet = new Set(q);
  const cSet = new Set(c);
  let overlap = 0;
  qSet.forEach((ch) => { if (cSet.has(ch)) overlap++; });
  const jac = overlap / Math.max(qSet.size, cSet.size);
  if (jac >= 0.6) return Math.round(40 + jac * 30);
  return 0;
}

function fuzzyInText(text, refName) {
  const t = normalizeFoodName(text);
  const c = normalizeFoodName(refName);
  if (!t || !c) return 0;
  if (t.includes(c)) return 85;
  const len = c.length;
  let best = 0;
  const maxWin = Math.min(t.length, len + 2);
  for (let win = Math.max(2, len - 2); win <= maxWin; win++) {
    for (let i = 0; i + win <= t.length; i++) {
      const score = foodMatchScore(t.slice(i, i + win), c);
      if (score > best) best = score;
    }
  }
  return best;
}

function matchWeightRefs(foodNames) {
  const matches = [];
  const seen = new Set();
  // 优先使用用户食物库（营养来自真实标签），再使用内置参考库
  const pool = allCustomFoods.map((food) => ({
    name: food.name,
    weight_g: food.weight_g,
    per100: food.per100 || null
  })).concat(weightRefs);
  for (const name of foodNames) {
    const n = String(name || '').trim();
    if (!n) continue;
    // 长文本（文字记录模式）用窗口模糊匹配，避免整段误匹配
    const isRawText = n.length > 16;
    const scored = [];
    for (const ref of pool) {
      if (seen.has(ref.name)) continue;
      const score = isRawText
        ? fuzzyInText(n, ref.name)
        : foodMatchScore(n, ref.name);
      if (score >= 45) scored.push({ ref, score });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const item of scored.slice(0, 3)) {
      if (seen.has(item.ref.name)) continue;
      seen.add(item.ref.name);
      matches.push(item.ref);
      if (matches.length >= 8) return matches;
    }
  }
  return matches;
}

async function loadWeightRefs() {
  try {
    const response = await fetch('./weight_refs.json');
    const data = await response.json();
    weightRefs = Array.isArray(data.entries) ? data.entries : [];
  } catch (error) {
    weightRefs = [];
    console.warn('估重参考库加载失败', error);
  }
}

function analyzerPrompt(visionText, foodNames) {
  const user = settings.user;
  const targets = targetsForDate(currentDate);
  const dayLabel = dayMetaForDate(currentDate).label;
  const refLines = matchWeightRefs(foodNames || [])
    .map((ref) => {
      const n = ref.per100;
      if (n) return `- ${ref.name}：约${ref.weight_g}克/份，每100克约 ${n.calories_kcal}kcal / 蛋白${n.protein_g}g / 碳水${n.carbs_g}g / 脂肪${n.fat_g}g`;
      return `- ${ref.name}：约${ref.weight_g}克/份`;
    })
    .join('\n');
  return `你是专业的减脂营养师。请根据下面的"食物识别结果"估算每项食物的重量（克）、热量（千卡）、蛋白质（克）、碳水化合物（克）、脂肪（克），并给出这一餐的总量。参照常见食物营养数据库（熟重、可食部），估算要保守，宁可低估也不要高估，因为用户正在减脂。用户信息：${user.height ? `身高${user.height}cm` : ''} ${user.weight ? `体重${user.weight}kg` : ''}；今日（${dayLabel}）目标：热量${targets.calories}kcal、蛋白质${targets.protein}g、碳水${targets.carbs}g、脂肪${targets.fat}g。
识别结果中的 size_cm 是参照卡片比例尺估算的食物尺寸。如果 package_info 提供了包装净含量/规格（如 15个275克），请优先按 净含量÷总数×实际数量 计算重量，包装信息优先于尺寸估算，不要用体积密度去猜；没有包装信息时才用 size_cm 和常见份量参考估算。weight_g 必须是可食部净重（去骨/去壳/去皮的重量）；如果食物带骨或带壳（如鸭腿、鸡腿、鱼、虾、蟹），先估算带骨/带壳毛重，再按常见可食部比例（如鸭腿约60-70%）折算成净重，并在 notes 中注明毛重与可食部比例。
常见份量参考（来自薄荷估重参考库）：
${refLines || '（无匹配条目）'}
如果某个食物没有任何参考条目，说明它不在参考库和用户食物库中，请用通用营养知识估算，并在 notes 中注明"通用知识估算，可能不准"。
严格按以下 JSON 格式输出（不要输出其他文字）：
{"foods":[{"name":"食物名称","weight_g":0,"calories_kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0}],"totals":{"calories_kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0},"notes":"简要备注，如估重依据或提醒"}

食物识别结果：
${visionText}`;
}

function textAnalyzerPrompt(text) {
  const user = settings.user;
  const targets = targetsForDate(currentDate);
  const dayLabel = dayMetaForDate(currentDate).label;
  const refLines = matchWeightRefs([text])
    .map((ref) => {
      const n = ref.per100;
      if (n) return `- ${ref.name}：约${ref.weight_g}克/份，每100克约 ${n.calories_kcal}kcal / 蛋白${n.protein_g}g / 碳水${n.carbs_g}g / 脂肪${n.fat_g}g`;
      return `- ${ref.name}：约${ref.weight_g}克/份`;
    })
    .join('\n');
  return `你是专业的减脂营养师。请根据用户的文字描述，识别每一种食物并估算重量（克）、热量（千卡）、蛋白质（克）、碳水化合物（克）、脂肪（克），并给出这一餐的总量。估算要保守，宁可低估也不要高估。weight_g 必须是可食部净重；如果描述里包含包装信息（如"一袋275克15个，吃了11个"），按 净含量÷总数×数量 计算。用户信息：${user.height ? `身高${user.height}cm` : ''} ${user.weight ? `体重${user.weight}kg` : ''}；今日（${dayLabel}）目标：热量${targets.calories}kcal、蛋白质${targets.protein}g、碳水${targets.carbs}g、脂肪${targets.fat}g。
常见份量参考（来自薄荷估重参考库，仅作校准）：
${refLines || '（无匹配条目）'}
如果描述中的食物与某个参考条目是同类食物（如 绿豆莲子粥 ≈ 牛乳绿豆莲子粥），优先采用参考条目的每份重量和每100克营养。
如果某个食物没有任何参考条目，说明它不在参考库和用户食物库中，请用通用营养知识估算，并在 notes 中注明"通用知识估算，可能不准"。
严格按以下 JSON 格式输出（不要输出其他文字）：
{"foods":[{"name":"食物名称","weight_g":0,"calories_kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0}],"totals":{"calories_kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0},"notes":"简要备注"}

用户描述：
${text}`;
}

function leftoverVisionPrompt() {
  const ref = settings.refCard;
  let refLine = '';
  if (ref.type === 'idcard') {
    refLine = '画面中有一张身份证或银行卡（标准尺寸长8.5cm、宽5.4cm），请把它当作比例尺，据此估算每个食物的实际尺寸（cm）。';
  } else if (ref.type === 'custom') {
    const len = num(ref.len) || 11.2;
    const wid = num(ref.wid) || 6.8;
    refLine = `画面中有一张卡片（长${len}cm、宽${wid}cm，尺寸指卡片本体，不含挂扣/挂绳等附件），请以卡片本体的边缘和四角为测量基准，忽略凸出的挂扣；如果挂扣遮挡了长边，请改用短边宽度${wid}cm 作基准。`;
  }
  return `你是食物识别助手。请仔细查看这张图片，识别图中剩余的食物和饮品（这是用户饭后没吃完的部分）。${refLine}请务必逐一列出画面中所有剩余食物，不要遗漏，每一样单独输出一项，并估算每项剩余重量（克）。如果图片中没有食物，输出 foods 为空数组。只描述你确实看到的内容，不要编造。严格按以下 JSON 格式输出（不要输出其他文字）：
{"foods":[{"name":"食物名称","portion":"大致份量","cooking":"烹饪方式","ingredients":"可见食材","size_cm":"约长8cm×宽5cm×高3cm"}],"scene":"场景描述"}`;
}

function leftoverAnalyzerPrompt(visionText, foodNames) {
  const refLines = matchWeightRefs(foodNames || [])
    .map((ref) => {
      const n = ref.per100;
      if (n) return `- ${ref.name}：约${ref.weight_g}克/份，每100克约 ${n.calories_kcal}kcal / 蛋白${n.protein_g}g / 碳水${n.carbs_g}g / 脂肪${n.fat_g}g`;
      return `- ${ref.name}：约${ref.weight_g}克/份`;
    })
    .join('\n');
  return `你是专业的减脂营养师。请根据下面的"剩余食物识别结果"估算每项剩余食物的重量（克）、热量（千卡）、蛋白质（克）、碳水化合物（克）、脂肪（克），并给出剩余总量。这是用户饭后没吃完的部分，估算要保守，宁可低估也不要高估。weight_g 必须是可食部净重。
常见份量参考（仅作校准）：
${refLines || '（无匹配条目）'}
严格按以下 JSON 格式输出（不要输出其他文字）：
{"foods":[{"name":"食物名称","weight_g":0,"calories_kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0}],"totals":{"calories_kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0},"notes":"简要备注"}

剩余食物识别结果：
${visionText}`;
}

function evaluatePrompt(daySummary, planText) {
  const user = settings.user;
  const targets = targetsForDate(currentDate);
  const dayLabel = dayMetaForDate(currentDate).label;
  return `你是用户的减脂教练。请基于以下信息评价用户今天的饮食并给出简短、具体、可执行的建议（中文，150字以内）：
用户信息：${user.height ? `身高${user.height}cm` : ''} ${user.weight ? `体重${user.weight}kg` : ''}；今日（${dayLabel}）目标：热量${targets.calories}kcal、蛋白质${targets.protein}g、碳水${targets.carbs}g、脂肪${targets.fat}g。
训练计划：${planText || '（未设置）'}

今日饮食记录：
${daySummary}`;
}

/* ============ 状态 ============ */
let currentDate = localDateString();
let pendingImageDataUrl = null;
let pendingImageDataUrl2 = null;
let pendingResult = null;
let pendingLeftover = null;
let leftoverImageDataUrl = null;
let leftoverImageDataUrl2 = null;
let leftoverBaselineMealId = null;
let allMeals = [];
let allBody = [];
let allCustomFoods = [];
let pendingFoodLabel = null;
let editingFoodId = null;

/* ============ 渲染：今日 ============ */
function mealTotals(meals) {
  const totals = { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  meals.forEach((meal) => {
    totals.calories_kcal += num(meal.totals.calories_kcal);
    totals.protein_g += num(meal.totals.protein_g);
    totals.carbs_g += num(meal.totals.carbs_g);
    totals.fat_g += num(meal.totals.fat_g);
  });
  return totals;
}

function renderTodayTotals() {
  const meals = allMeals.filter((meal) => meal.date === currentDate);
  const totals = mealTotals(meals);
  const targets = targetsForDate(currentDate);
  const item = (label, value, unit, key, cls) => {
    const target = targets[key];
    const over = target > 0 && value > target * 1.15;
    const hit = target > 0 && !over;
    return `<div class="total-item ${cls || ''} ${over ? 'over' : ''} ${hit && value > 0 ? 'hit' : ''}"><div class="num">${Math.round(value)}</div><div class="label">${label} / ${target}</div><div class="label">${unit}</div></div>`;
  };
  $('#todayTotals').innerHTML =
    item('热量', totals.calories_kcal, '千卡', 'calories', 'kcal') +
    item('蛋白质', totals.protein_g, '克', 'protein') +
    item('碳水', totals.carbs_g, '克', 'carbs') +
    item('脂肪', totals.fat_g, '克', 'fat');
}

function renderTodayMeals() {
  const meals = allMeals
    .filter((meal) => meal.date === currentDate)
    .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
  if (!meals.length) {
    $('#todayMeals').innerHTML = '<div class="card"><p class="muted">今天还没有记录，拍一张食物照片开始吧。</p></div>';
    return;
  }
  $('#todayMeals').innerHTML = meals.map((meal) => {
    const foods = meal.foods.map((food) => `${food.name}${food.weight_g > 0 ? ` ${round(food.weight_g)}g` : ''}`).join('、');
    return `<div class="meal-item">
      <div class="head">
        <span class="tag">${esc(meal.mealType)} · ${esc(meal.time || '')}</span>
        <span>${Math.round(num(meal.totals.calories_kcal))} 千卡</span>
      </div>
      <div class="body">
        ${meal.thumb ? `<img class="thumb" src="${meal.thumb}" alt="餐食照片">` : ''}
        <div>
          <div class="foods">${esc(foods)}</div>
          <div class="macros">蛋白质 ${round(meal.totals.protein_g)}g · 碳水 ${round(meal.totals.carbs_g)}g · 脂肪 ${round(meal.totals.fat_g)}g</div>
        </div>
      </div>
      <div class="btn-row">
        <button class="small-btn" data-edit-meal="${meal.id}">编辑</button>
        <button class="del-btn" data-del-meal="${meal.id}">删除</button>
      </div>
    </div>`;
  }).join('');
}

function refreshToday() {
  renderTodayTotals();
  renderTodayMeals();
}

/* ============ 分析流程 ============ */
function setStatus(selector, text, kind) {
  const node = $(selector);
  node.className = 'status' + (kind ? ' ' + kind : '');
  node.textContent = text || '';
}

async function runAnalysis() {
  if (!pendingImageDataUrl) return;
  if (!settings.glmKey) {
    setStatus('#analyzeStatus', '请先到「设置」填写 GLM API Key。', 'error');
    return;
  }
  resetLeftoverState();
  const button = $('#analyzeBtn');
  button.disabled = true;
  setStatus('#analyzeStatus', '第 1/2 步：GLM 正在识别图片中的食物…', 'loading');
  try {
    const visionContent = [];
    if (pendingImageDataUrl2) {
      visionContent.push({ type: 'text', text: '以下包含两张照片，拍摄时工牌/卡片和食物都保持位置不动：第一张为俯视（卡片平放），第二张为前上视角（约45度）。请先比较卡片在两张照片中的视尺寸/形状变化（如宽度被压缩的比例），推断两次拍摄的角度差异；再结合食物在两个视角下的相对位置偏移（视差），估算每个食物的高度/深度。第一张里的卡片校准水平尺寸（长×宽），第二张里的卡片校准角度和高度。每张照片分别用各自画面里的卡片做比例尺，不要跨照片套用比例。' });
      visionContent.push({ type: 'image_url', image_url: { url: pendingImageDataUrl } });
      visionContent.push({ type: 'image_url', image_url: { url: pendingImageDataUrl2 } });
      visionContent.push({ type: 'text', text: visionPrompt() });
    } else {
      visionContent.push({ type: 'image_url', image_url: { url: pendingImageDataUrl } });
      visionContent.push({ type: 'text', text: visionPrompt() });
    }
    const visionText = await glmVision([{ role: 'user', content: visionContent }]);
    const visionJson = extractJson(visionText);
    const visionNames = visionJson && Array.isArray(visionJson.foods)
      ? visionJson.foods.map((food) => String(food.name || '').trim()).filter(Boolean)
      : [];
    const visionDescription = visionJson ? JSON.stringify(visionJson, null, 2) : visionText;

    setStatus('#analyzeStatus', settings.dsKey ? '第 2/2 步：DeepSeek 正在估重和计算营养…' : '第 2/2 步：正在估重和计算营养…', 'loading');
    let analysisText = null;
    let parsed = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      analysisText = await analyzerChat([
        { role: 'user', content: analyzerPrompt(visionDescription, visionNames) }
      ]);
      parsed = extractJson(analysisText);
      if (parsed && Array.isArray(parsed.foods)) break;
      if (attempt === 0) {
        setStatus('#analyzeStatus', '第 2/2 步：模型输出格式异常，正在自动重试…', 'loading');
        await sleep(1500);
      }
    }
    if (!parsed || !Array.isArray(parsed.foods)) {
      throw new Error('模型返回格式无法解析，请重试。原始内容：' + analysisText.slice(0, 200));
    }
    const visionFoods = visionJson && Array.isArray(visionJson.foods) ? visionJson.foods : [];
    const foods = parsed.foods.map((food, index) => {
      const item = {
        name: String(food.name || '未命名'),
        weight_g: round(food.weight_g),
        calories_kcal: round(food.calories_kcal),
        protein_g: round(food.protein_g),
        carbs_g: round(food.carbs_g),
        fat_g: round(food.fat_g),
        package_info: null
      };
      const visionFood = visionFoods[index] || visionFoods.find((f) => String(f.name || '') === item.name);
      if (visionFood && visionFood.package_info && num(visionFood.package_info.net_weight_g) > 0 && num(visionFood.package_info.count) > 0) {
        item.package_info = {
          net_weight_g: num(visionFood.package_info.net_weight_g),
          count: num(visionFood.package_info.count),
          unit_text: String(visionFood.package_info.unit_text || ''),
          qty: Math.max(1, num(visionFood.package_info.visible_count) || 1)
        };
      }
      return item;
    });
    const totals = { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    foods.forEach((food) => {
      totals.calories_kcal += food.calories_kcal;
      totals.protein_g += food.protein_g;
      totals.carbs_g += food.carbs_g;
      totals.fat_g += food.fat_g;
    });
    pendingResult = {
      foods,
      totals,
      notes: String(parsed.notes || ''),
      visionRaw: visionText,
      thumb: imageToDataURL(await loadImage(pendingImageDataUrl), 320, 0.7)
    };
    renderAnalysisResult();
    setStatus('#analyzeStatus', '', '');
  } catch (error) {
    setStatus('#analyzeStatus', '分析失败：' + error.message, 'error');
  } finally {
    button.disabled = !pendingImageDataUrl;
  }
}

function setTextStatus(text, kind) {
  const node = $('#textStatus');
  node.className = 'status' + (kind ? ' ' + kind : '');
  node.textContent = text || '';
}

function detectMealTypeFromText(text) {
  if (/早上|早餐|早饭|早晨/.test(text)) return '早餐';
  if (/中午|午餐|午饭|中饭/.test(text)) return '午餐';
  if (/晚上|晚餐|晚饭|傍晚/.test(text)) return '晚餐';
  if (/加餐|下午茶|宵夜|夜宵/.test(text)) return '加餐';
  return null;
}

async function runTextAnalysis() {
  const text = $('#textInput').value.trim();
  if (!text) {
    setTextStatus('请先输入食物描述。', 'error');
    return;
  }
  if (!settings.dsKey && !settings.glmKey) {
    setTextStatus('请先到「设置」配置 API Key。', 'error');
    return;
  }
  resetLeftoverState();
  const detected = detectMealTypeFromText(text);
  if (detected) $('#textMealType').value = detected;
  const mealHits = (text.match(/早上|早餐|早饭|早晨|中午|午餐|午饭|中饭|晚上|晚餐|晚饭|傍晚|加餐|下午茶|宵夜|夜宵/g) || []);
  const mealSet = new Set(mealHits.map((hit) => detectMealTypeFromText(hit)));
  const multiMealNotice = mealSet.size > 1
    ? `（检测到多个餐次，已按「${$('#textMealType').value}」记录；多餐次请分开输入）`
    : '';
  const button = $('#textAnalyzeBtn');
  button.disabled = true;
  setTextStatus('AI 正在识别文字并估重…', 'loading');
  try {
    let analysisText = null;
    let parsed = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      analysisText = await analyzerChat([
        { role: 'user', content: textAnalyzerPrompt(text) }
      ]);
      parsed = extractJson(analysisText);
      if (parsed && Array.isArray(parsed.foods)) break;
      if (attempt === 0) {
        setTextStatus('输出格式异常，自动重试…', 'loading');
        await sleep(1500);
      }
    }
    if (!parsed || !Array.isArray(parsed.foods)) {
      throw new Error('模型返回格式无法解析，请重试。原始内容：' + analysisText.slice(0, 200));
    }
    const foods = parsed.foods.map((food) => ({
      name: String(food.name || '未命名'),
      weight_g: round(food.weight_g),
      calories_kcal: round(food.calories_kcal),
      protein_g: round(food.protein_g),
      carbs_g: round(food.carbs_g),
      fat_g: round(food.fat_g),
      package_info: null
    }));
    const totals = { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    foods.forEach((food) => {
      totals.calories_kcal += food.calories_kcal;
      totals.protein_g += food.protein_g;
      totals.carbs_g += food.carbs_g;
      totals.fat_g += food.fat_g;
    });
    pendingResult = {
      foods,
      totals,
      notes: String(parsed.notes || ''),
      visionRaw: '',
      thumb: '',
      mealType: $('#textMealType').value
    };
    renderAnalysisResult();
    setTextStatus('识别完成' + multiMealNotice + '，请核对后记录 ✓', 'ok');
  } catch (error) {
    setTextStatus('识别失败：' + error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/* ============ 手动记录 ============ */
let manualFoods = [];

function refreshManualDatalist() {
  const datalist = $('#manualFoodDatalist');
  if (!datalist) return;
  datalist.innerHTML = allCustomFoods
    .map((food) => `<option value="${esc(food.name)}"></option>`)
    .join('');
}

function setManualStatus(text, kind) {
  const node = $('#manualStatus');
  node.className = 'status' + (kind ? ' ' + kind : '');
  node.textContent = text || '';
}

function renderManualList() {
  const wrap = $('#manualList');
  const saveBtn = $('#manualSaveBtn');
  if (!manualFoods.length) {
    wrap.innerHTML = '<p class="muted">还没有添加食物，先填写上方名称和营养数据。</p>';
    saveBtn.disabled = true;
    return;
  }
  const totals = { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  manualFoods.forEach((food) => {
    totals.calories_kcal += food.calories_kcal;
    totals.protein_g += food.protein_g;
    totals.carbs_g += food.carbs_g;
    totals.fat_g += food.fat_g;
  });
  const rows = manualFoods.map((food, index) => {
    const weightText = food.weight_g > 0 ? ` ${round(food.weight_g)}g` : '';
    return `<div class="manual-food-row">
      <div class="head">
        <strong>${esc(food.name)}</strong>${weightText}
        <button class="del-btn" data-manual-del="${index}">删除</button>
      </div>
      <div class="macros">${Math.round(food.calories_kcal)} kcal · 蛋白 ${round(food.protein_g)}g · 碳水 ${round(food.carbs_g)}g · 脂肪 ${round(food.fat_g)}g</div>
    </div>`;
  }).join('');
  wrap.innerHTML = rows +
    `<div class="manual-totals">小计：${Math.round(totals.calories_kcal)} kcal · 蛋白 ${round(totals.protein_g)}g · 碳水 ${round(totals.carbs_g)}g · 脂肪 ${round(totals.fat_g)}g</div>`;
  saveBtn.disabled = false;
  saveBtn.textContent = `✓ 保存为「${$('#manualMealType').value}」记录`;
}

function addManualFood() {
  const name = $('#manualName').value.trim();
  if (!name) {
    setManualStatus('请填写食物名称。', 'error');
    return;
  }
  const food = {
    name,
    weight_g: num($('#manualWeight').value),
    calories_kcal: num($('#manualKcal').value),
    protein_g: num($('#manualProtein').value),
    carbs_g: num($('#manualCarbs').value),
    fat_g: num($('#manualFat').value),
    package_info: null
  };
  manualFoods.push(food);
  $('#manualName').value = '';
  $('#manualWeight').value = '';
  $('#manualKcal').value = '';
  $('#manualProtein').value = '';
  $('#manualCarbs').value = '';
  $('#manualFat').value = '';
  renderManualList();
  setManualStatus(`已添加「${name}」，可继续添加其他食物 ✓`, 'ok');
  $('#manualName').focus();
}

function clearManualList() {
  if (manualFoods.length && !window.confirm('清空手动记录列表？')) return;
  manualFoods = [];
  renderManualList();
  setManualStatus('', '');
}

async function saveManualMeal() {
  if (!manualFoods.length) return;
  const mealType = $('#manualMealType').value;
  const totals = { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  manualFoods.forEach((food) => {
    totals.calories_kcal += food.calories_kcal;
    totals.protein_g += food.protein_g;
    totals.carbs_g += food.carbs_g;
    totals.fat_g += food.fat_g;
  });
  const now = new Date();
  const meal = {
    id: uid(),
    date: currentDate,
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    mealType,
    foods: manualFoods.map((food) => Object.assign({}, food)),
    totals: {
      calories_kcal: round(totals.calories_kcal),
      protein_g: round(totals.protein_g),
      carbs_g: round(totals.carbs_g),
      fat_g: round(totals.fat_g)
    },
    notes: '手动记录',
    thumb: '',
    visionRaw: ''
  };
  await idbPut('meals', meal);
  allMeals.push(meal);
  manualFoods = [];
  renderManualList();
  setManualStatus(`已保存「${mealType}」记录 ✓（${Math.round(meal.totals.calories_kcal)} kcal）`, 'ok');
  refreshToday();
  renderHistory();
}

function setLeftoverStatus(text, kind) {
  const node = $('#leftoverStatus');
  node.className = 'status' + (kind ? ' ' + kind : '');
  node.textContent = text || '';
}

function resetLeftoverState() {
  pendingLeftover = null;
  leftoverImageDataUrl = null;
  leftoverImageDataUrl2 = null;
  leftoverBaselineMealId = null;
  $('#leftoverInput').value = '';
  $('#leftoverInput2').value = '';
  $('#leftoverAlbumInput').value = '';
  $('#leftoverAlbumInput2').value = '';
  $('#leftoverPreviewWrap').classList.add('hidden');
  $('#leftoverPreviewWrap2').classList.add('hidden');
  $('#leftoverResult').classList.add('hidden');
  $('#applyLeftoverBtn').disabled = true;
  $('#leftoverHint').textContent = '剩余：俯视图（工牌平放旁边）';
  $('#leftoverHint2').textContent = '剩余：前上45°（可选，工牌和食物都别动）';
  setLeftoverStatus('', '');
}

function renderLeftoverResult() {
  if (!pendingLeftover) return;
  const rows = pendingLeftover.foods.map((food) =>
    `${food.name} ${food.weight_g}g（${food.calories_kcal}kcal）`
  ).join('\n');
  $('#leftoverResult').textContent =
    `剩余合计：${Math.round(pendingLeftover.totals.calories_kcal)} kcal\n${rows}\n${pendingLeftover.notes || ''}`;
  $('#leftoverResult').classList.remove('hidden');
}

async function runLeftoverAnalysis() {
  let baselineNote = '使用当前待确认的餐前结果';
  if (!pendingResult) {
    const todayMeals = allMeals
      .filter((meal) => meal.date === currentDate)
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const latest = todayMeals[todayMeals.length - 1];
    if (!latest) {
      setLeftoverStatus('今天还没有已保存的餐前记录，请先完成餐前分析并记录。', 'error');
      return;
    }
    leftoverBaselineMealId = latest.id;
    baselineNote = `以今天最近一条已保存记录为基准（${latest.mealType} ${latest.time}，${Math.round(latest.totals.calories_kcal)} kcal）`;
  }
  if (!leftoverImageDataUrl) {
    setLeftoverStatus('请先拍一张剩余食物的照片。', 'error');
    return;
  }
  if (!settings.glmKey) {
    setLeftoverStatus('请先到「设置」配置 GLM API Key。', 'error');
    return;
  }
  const button = $('#leftoverAnalyzeBtn');
  button.disabled = true;
  setLeftoverStatus('正在识别剩余食物…（' + baselineNote + '）', 'loading');
  try {
    const visionContent = [];
    if (leftoverImageDataUrl2) {
      visionContent.push({ type: 'text', text: '以下包含两张照片：第一张为主视角（俯视），第二张为前上45°视角，均为饭后剩余食物，工牌/卡片与食物保持不动。' });
      visionContent.push({ type: 'image_url', image_url: { url: leftoverImageDataUrl } });
      visionContent.push({ type: 'image_url', image_url: { url: leftoverImageDataUrl2 } });
      visionContent.push({ type: 'text', text: leftoverVisionPrompt() });
    } else {
      visionContent.push({ type: 'image_url', image_url: { url: leftoverImageDataUrl } });
      visionContent.push({ type: 'text', text: leftoverVisionPrompt() });
    }
    const visionText = await glmVision([{ role: 'user', content: visionContent }]);
    const visionJson = extractJson(visionText);
    const visionNames = visionJson && Array.isArray(visionJson.foods)
      ? visionJson.foods.map((food) => String(food.name || '').trim()).filter(Boolean)
      : [];
    const visionDescription = visionJson ? JSON.stringify(visionJson, null, 2) : visionText;
    let analysisText = null;
    let parsed = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      analysisText = await analyzerChat([
        { role: 'user', content: leftoverAnalyzerPrompt(visionDescription, visionNames) }
      ]);
      parsed = extractJson(analysisText);
      if (parsed && Array.isArray(parsed.foods)) break;
      if (attempt === 0) {
        setLeftoverStatus('输出格式异常，自动重试…', 'loading');
        await sleep(1500);
      }
    }
    if (!parsed || !Array.isArray(parsed.foods)) {
      throw new Error('模型返回格式无法解析，请重试。原始内容：' + analysisText.slice(0, 200));
    }
    const foods = parsed.foods.map((food) => ({
      name: String(food.name || '未命名'),
      weight_g: round(food.weight_g),
      calories_kcal: round(food.calories_kcal),
      protein_g: round(food.protein_g),
      carbs_g: round(food.carbs_g),
      fat_g: round(food.fat_g),
      package_info: null
    }));
    const totals = { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    foods.forEach((food) => {
      totals.calories_kcal += food.calories_kcal;
      totals.protein_g += food.protein_g;
      totals.carbs_g += food.carbs_g;
      totals.fat_g += food.fat_g;
    });
    pendingLeftover = { foods, totals, notes: String(parsed.notes || '') };
    renderLeftoverResult();
    $('#applyLeftoverBtn').disabled = false;
    setLeftoverStatus('剩余识别完成，可点「计算实际摄入」扣除。', 'ok');
  } catch (error) {
    setLeftoverStatus('识别失败：' + error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function computeEatenFromLeftover() {
  if (!pendingLeftover) return;
  let preFoods = [];
  let preTotals = { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  let targetMeal = null;
  if (pendingResult) {
    preFoods = pendingResult.foods || [];
    preTotals = pendingResult.totals || preTotals;
  } else if (leftoverBaselineMealId) {
    targetMeal = allMeals.find((meal) => meal.id === leftoverBaselineMealId);
    if (!targetMeal) {
      setLeftoverStatus('餐前记录不存在（可能已删除），请重新记录后再核对剩余。', 'error');
      return;
    }
    preFoods = targetMeal.foods || [];
    preTotals = targetMeal.totals || preTotals;
  } else {
    setLeftoverStatus('缺少餐前基准，请先完成餐前分析或记录餐前热量。', 'error');
    return;
  }
  const leftoverByName = new Map();
  for (const lf of pendingLeftover.foods) {
    let best = null;
    let bestScore = 0;
    for (const pre of preFoods) {
      const score = foodMatchScore(pre.name, lf.name);
      if (score > bestScore) {
        bestScore = score;
        best = pre;
      }
    }
    if (best && bestScore >= 45) {
      leftoverByName.set(best.name, (leftoverByName.get(best.name) || 0) + lf.weight_g);
    }
  }
  const originalKcal = Math.round(preTotals.calories_kcal);
  const eaten = [];
  for (const pre of preFoods) {
    const leftoverW = leftoverByName.get(pre.name) || 0;
    const eatenW = Math.max(0, pre.weight_g - leftoverW);
    if (eatenW < 1) continue;
    const ratio = pre.weight_g > 0 ? eatenW / pre.weight_g : 0;
    eaten.push({
      name: pre.name,
      weight_g: round(eatenW),
      calories_kcal: round(pre.calories_kcal * ratio),
      protein_g: round(pre.protein_g * ratio),
      carbs_g: round(pre.carbs_g * ratio),
      fat_g: round(pre.fat_g * ratio),
      package_info: pre.package_info || null
    });
  }
  if (!eaten.length) {
    setLeftoverStatus('剩余识别量不低于餐前估算（可能识别有误），请重新识别剩余或核对餐前结果。', 'error');
    return;
  }
  const unmatchedLeftover = [];
  for (const lf of pendingLeftover.foods) {
    let matched = false;
    for (const pre of preFoods) {
      if (foodMatchScore(pre.name, lf.name) >= 45) {
        matched = true;
        break;
      }
    }
    if (!matched) unmatchedLeftover.push(lf.name);
  }
  const totals = { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  eaten.forEach((food) => {
    totals.calories_kcal += food.calories_kcal;
    totals.protein_g += food.protein_g;
    totals.carbs_g += food.carbs_g;
    totals.fat_g += food.fat_g;
  });
  const unmatchedNote = unmatchedLeftover.length
    ? `；剩余中有未匹配餐前记录的食物：${unmatchedLeftover.join('、')}`
    : '';
  const noteTail = `已扣除剩余（餐前 ${originalKcal} kcal → 实食 ${Math.round(totals.calories_kcal)} kcal）${unmatchedNote}`;
  if (pendingResult) {
    pendingResult.foods = eaten;
    pendingResult.totals = totals;
    pendingResult.notes = `${pendingResult.notes ? pendingResult.notes + '；' : ''}${noteTail}`;
    pendingLeftover = null;
    $('#leftoverResult').classList.add('hidden');
    $('#applyLeftoverBtn').disabled = true;
    renderAnalysisResult();
    setLeftoverStatus('已按剩余扣除，结果已更新为实际摄入，请核对后记录 ✓', 'ok');
    return;
  }
  // 已保存记录模式：直接更新原记录
  targetMeal.foods = eaten;
  targetMeal.totals = totals;
  targetMeal.notes = `${targetMeal.notes ? targetMeal.notes + '；' : ''}${noteTail}`;
  await idbPut('meals', targetMeal);
  allMeals = allMeals.map((meal) => (meal.id === targetMeal.id ? targetMeal : meal));
  pendingLeftover = null;
  leftoverBaselineMealId = null;
  $('#leftoverResult').classList.add('hidden');
  $('#applyLeftoverBtn').disabled = true;
  refreshToday();
  renderHistory();
  setLeftoverStatus(`已更新已保存的「${targetMeal.mealType} ${targetMeal.time}」记录：餐前 ${originalKcal} kcal → 实食 ${Math.round(totals.calories_kcal)} kcal ✓`, 'ok');
}

function editMeal(mealId) {
  const meal = allMeals.find((item) => item.id === mealId);
  if (!meal) return;
  resetLeftoverState();
  pendingResult = {
    editId: meal.id,
    foods: (meal.foods || []).map((food) => Object.assign({}, food, { package_info: food.package_info || null })),
    totals: Object.assign({ calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, meal.totals || {}),
    notes: meal.notes || '',
    visionRaw: meal.visionRaw || '',
    thumb: meal.thumb || '',
    mealType: meal.mealType
  };
  renderAnalysisResult();
  $('#analysisResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setStatus('#analyzeStatus', '正在编辑已保存的记录，修改后点「保存修改」。', 'ok');
}

function renderAnalysisResult() {
  if (!pendingResult) return;
  const { foods, totals, notes } = pendingResult;
  const rows = foods.map((food, index) => `
    <div class="food-result" data-food-index="${index}">
      <div class="name">${esc(food.name)}</div>
      <div class="editable">
        <input type="number" class="f-weight" value="${food.weight_g}" step="1" data-field="weight_g" title="重量 g">
        <input type="number" class="f-kcal" value="${food.calories_kcal}" step="1" data-field="calories_kcal" title="热量 kcal">
        <input type="number" class="f-protein" value="${food.protein_g}" step="0.1" data-field="protein_g" title="蛋白质 g">
        <input type="number" class="f-carbs" value="${food.carbs_g}" step="0.1" data-field="carbs_g" title="碳水 g">
        <input type="number" class="f-fat" value="${food.fat_g}" step="0.1" data-field="fat_g" title="脂肪 g">
      </div>
      ${food.package_info ? `<div class="pkg-row">
        <span class="muted">包装：${esc(food.package_info.unit_text || (food.package_info.net_weight_g + '克/' + food.package_info.count + '个'))}</span>
        <label>数量 <input type="number" class="f-qty" value="${food.package_info.qty}" min="0" step="1" data-field="qty"></label>
        <span class="muted">个/份，自动按总净含量折算</span>
      </div>` : ''}
      <div class="meta">重量 / 热量 / 蛋白质 / 碳水 / 脂肪（可修改）</div>
    </div>`).join('');
  $('#analysisResult').innerHTML = `
    <div class="card">
      <h2>AI 估算结果 <span class="muted">（可手动修正后记录）</span></h2>
      ${rows}
      <div class="result-totals">
        <div><div class="num">${Math.round(totals.calories_kcal)}</div><div class="muted">千卡</div></div>
        <div><div class="num">${round(totals.protein_g)}</div><div class="muted">蛋白质 g</div></div>
        <div><div class="num">${round(totals.carbs_g)}</div><div class="muted">碳水 g</div></div>
        <div><div class="num">${round(totals.fat_g)}</div><div class="muted">脂肪 g</div></div>
      </div>
      ${notes ? `<div class="result-notes">备注：${esc(notes)}</div>` : ''}
      <div class="save-result-row">
        <button id="confirmSaveBtn" class="primary-btn">${pendingResult.editId ? '保存修改' : '✓ 记录这一餐'}</button>
        <button id="discardResultBtn" class="small-btn">放弃</button>
      </div>
    </div>`;
  $('#analysisResult').classList.remove('hidden');
  $('#analysisResult').scrollIntoView({ behavior: 'smooth', block: 'start' });

  $('#analysisResult').querySelectorAll('.food-result').forEach((row) => {
    row.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => {
        const index = parseInt(row.dataset.foodIndex, 10);
        const field = input.dataset.field;
        const food = pendingResult.foods[index];
        if (field === 'qty') {
          const qty = num(input.value);
          const pkg = food.package_info;
          if (pkg && pkg.net_weight_g > 0 && pkg.count > 0) {
            pkg.qty = qty;
            const perPiece = pkg.net_weight_g / pkg.count;
            const newWeight = perPiece * qty;
            if (food.weight_g > 0) {
              const ratio = newWeight / food.weight_g;
              food.weight_g = round(newWeight);
              food.calories_kcal = round(food.calories_kcal * ratio);
              food.protein_g = round(food.protein_g * ratio);
              food.carbs_g = round(food.carbs_g * ratio);
              food.fat_g = round(food.fat_g * ratio);
            }
          }
        } else {
          food[field] = num(input.value);
        }
        pendingResult.totals = { calories_kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
        pendingResult.foods.forEach((food) => {
          pendingResult.totals.calories_kcal += food.calories_kcal;
          pendingResult.totals.protein_g += food.protein_g;
          pendingResult.totals.carbs_g += food.carbs_g;
          pendingResult.totals.fat_g += food.fat_g;
        });
        row.querySelector('.f-weight').value = food.weight_g;
        row.querySelector('.f-kcal').value = food.calories_kcal;
        row.querySelector('.f-protein').value = food.protein_g;
        row.querySelector('.f-carbs').value = food.carbs_g;
        row.querySelector('.f-fat').value = food.fat_g;
        if (row.querySelector('.f-qty')) row.querySelector('.f-qty').value = food.package_info ? food.package_info.qty : 1;
        document.querySelectorAll('.result-totals .num')[0].textContent = Math.round(pendingResult.totals.calories_kcal);
        document.querySelectorAll('.result-totals .num')[1].textContent = round(pendingResult.totals.protein_g);
        document.querySelectorAll('.result-totals .num')[2].textContent = round(pendingResult.totals.carbs_g);
        document.querySelectorAll('.result-totals .num')[3].textContent = round(pendingResult.totals.fat_g);
      });
    });
  });

  $('#confirmSaveBtn').addEventListener('click', confirmSaveMeal);
  $('#discardResultBtn').addEventListener('click', () => {
    pendingResult = null;
    $('#analysisResult').classList.add('hidden');
  });
}

async function confirmSaveMeal() {
  if (!pendingResult) return;
  const editId = pendingResult.editId || null;
  const existing = editId ? allMeals.find((meal) => meal.id === editId) : null;
  const now = new Date();
  const meal = {
    id: editId || uid(),
    date: existing ? existing.date : currentDate,
    time: existing ? existing.time : `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    mealType: pendingResult.mealType || $('#mealType').value,
    foods: pendingResult.foods,
    totals: pendingResult.totals,
    notes: pendingResult.notes,
    thumb: pendingResult.thumb,
    visionRaw: pendingResult.visionRaw
  };
  await idbPut('meals', meal);
  if (existing) {
    allMeals = allMeals.map((item) => (item.id === editId ? meal : item));
  } else {
    allMeals.push(meal);
  }
  pendingResult = null;
  pendingImageDataUrl = null;
  pendingImageDataUrl2 = null;
  $('#photoInput').value = '';
  $('#photoInput2').value = '';
  $('#photoAlbumInput').value = '';
  $('#photoAlbumInput2').value = '';
  $('#photoPreviewWrap').classList.add('hidden');
  $('#photoPreviewWrap2').classList.add('hidden');
  $('#captureHint2').textContent = '＋第二视角（前上45°，工牌和食物都别动，可选）';
  $('#analysisResult').classList.add('hidden');
  $('#analyzeBtn').disabled = true;
  setStatus('#analyzeStatus', editId ? '已保存修改 ✓' : '已记录 ✓', 'ok');
  refreshToday();
}

/* ============ AI 评价 ============ */
async function runEvaluate() {
  const dayMeals = allMeals.filter((meal) => meal.date === currentDate);
  if (!dayMeals.length) {
    setStatus('#evaluateResult', '今天还没有饮食记录，先记录一餐再来评价。', 'error');
    return;
  }
  if (!settings.dsKey && !settings.glmKey) {
    setStatus('#evaluateResult', '请先到「设置」配置 API Key。', 'error');
    return;
  }
  const summary = dayMeals.map((meal) => {
    const foods = meal.foods.map((f) => `${f.name} ${f.weight_g}g(${f.calories_kcal}kcal)`).join('、');
    return `${meal.mealType} ${meal.time}: ${foods}；小计 ${meal.totals.calories_kcal}kcal`;
  }).join('\n');
  const button = $('#evaluateBtn');
  button.disabled = true;
  $('#evaluateResult').innerHTML = '正在分析…';
  try {
    const reply = await analyzerChat([
      { role: 'user', content: evaluatePrompt(summary, settings.plan) }
    ], { maxTokens: 1200, jsonMode: false });
    $('#evaluateResult').innerHTML = esc(reply);
  } catch (error) {
    $('#evaluateResult').innerHTML = '评价失败：' + esc(error.message);
  } finally {
    button.disabled = false;
  }
}

/* ============ 历史 ============ */
function renderHistory() {
  const byDate = {};
  allMeals.forEach((meal) => {
    (byDate[meal.date] = byDate[meal.date] || []).push(meal);
  });
  const dates = Object.keys(byDate).sort().reverse().slice(0, 30);
  if (!dates.length) {
    $('#historyList').innerHTML = '<p class="muted">暂无记录。</p>';
    return;
  }
  $('#historyList').innerHTML = dates.map((date) => {
    const meals = byDate[date];
    const totals = mealTotals(meals);
    return `<div class="history-day">
      <div class="head"><strong>${esc(date)}</strong><span class="kcal">${Math.round(totals.calories_kcal)} 千卡</span></div>
      <div class="macros">蛋白质 ${round(totals.protein_g)}g · 碳水 ${round(totals.carbs_g)}g · 脂肪 ${round(totals.fat_g)}g · ${meals.length} 餐</div>
    </div>`;
  }).join('');
}

/* ============ 身体 ============ */
function renderBody() {
  const list = allBody.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  $('#bodyList').innerHTML = list.length
    ? list.map((record) => `<div class="body-row">
        <span>${esc(record.date)}</span>
        <span>${record.weight ? record.weight + 'kg' : '—'} ${record.chest ? '胸' + record.chest : ''} ${record.waist ? '腰' + record.waist : ''} ${record.hip ? '臀' + record.hip : ''}</span>
        <button class="del-btn" data-del-body="${record.id}">删除</button>
      </div>`).join('')
    : '<p class="muted">还没有身体记录，保存一条体重/三围数据。</p>';
  drawBodyChart();
}

function drawBodyChart() {
  const canvas = $('#bodyChart');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const records = allBody.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const weights = records.filter((record) => record.weight).map((record) => ({ date: record.date, value: num(record.weight) }));
  if (weights.length < 2) {
    ctx.fillStyle = '#8fa2bd';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('至少需要 2 条体重记录才能显示趋势', canvas.width / 2, canvas.height / 2);
    return;
  }
  const min = Math.min(...weights.map((w) => w.value));
  const max = Math.max(...weights.map((w) => w.value));
  const pad = 16;
  const plotW = canvas.width - pad * 2;
  const plotH = canvas.height - pad * 2;
  const x = (index) => pad + (plotW * index) / (weights.length - 1);
  const y = (value) => pad + plotH - ((value - min) / (max - min || 1)) * plotH;
  ctx.strokeStyle = '#14b8a6';
  ctx.lineWidth = 2;
  ctx.beginPath();
  weights.forEach((w, index) => (index ? ctx.lineTo(x(index), y(w.value)) : ctx.moveTo(x(index), y(w.value))));
  ctx.stroke();
  ctx.fillStyle = '#14b8a6';
  weights.forEach((w, index) => {
    ctx.beginPath();
    ctx.arc(x(index), y(w.value), 3, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = '#8fa2bd';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(min) + 'kg', 30, canvas.height - 4);
  ctx.fillText(String(max) + 'kg', 30, 12);
}

/* ============ 食物库 ============ */
function setFoodStatus(text, kind) {
  const node = $('#foodFormStatus');
  node.className = 'status' + (kind ? ' ' + kind : '');
  node.textContent = text || '';
}

function resetFoodForm() {
  editingFoodId = null;
  pendingFoodLabel = null;
  $('#foodName').value = '';
  $('#foodWeight').value = '';
  $('#foodKcal').value = '';
  $('#foodProtein').value = '';
  $('#foodCarbs').value = '';
  $('#foodFat').value = '';
  $('#foodLabelInput').value = '';
  $('#foodLabelAlbumInput').value = '';
  $('#foodLabelPreview').classList.add('hidden');
  $('#foodLabelPreview').innerHTML = '';
  $('#addFoodBtn').textContent = '保存食物';
  setFoodStatus('', '');
}

function renderCustomFoods() {
  const query = $('#foodSearch') ? $('#foodSearch').value.trim() : '';
  let list = allCustomFoods.slice();
  if (query) {
    list = list
      .map((food) => ({ food, score: foodMatchScore(query, food.name) }))
      .filter((item) => item.score >= 50)
      .sort((a, b) => b.score - a.score || a.food.name.localeCompare(b.food.name, 'zh'))
      .map((item) => item.food);
  } else {
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }
  if (!list.length) {
    $('#foodList').innerHTML = allCustomFoods.length
      ? '<p class="muted">没有匹配的食物，换个关键词试试。</p>'
      : '<p class="muted">还没有自定义食物，在下方添加一个吧。</p>';
    return;
  }
  $('#foodList').innerHTML = list.map((food) => {
    const p = food.per100 || {};
    return `<div class="custom-food" data-id="${esc(food.id)}">
      <div class="head"><strong>${esc(food.name)}</strong><span class="muted">一份 ${round(food.weight_g)}g</span></div>
      <div class="macros">每100g：${round(p.calories_kcal)} kcal · 蛋白 ${round(p.protein_g)}g · 碳水 ${round(p.carbs_g)}g · 脂肪 ${round(p.fat_g)}g</div>
      <div class="btn-row">
        <button class="small-btn" data-edit-food="${esc(food.id)}">编辑</button>
        <button class="small-btn" data-quick-food="${esc(food.id)}">＋加到今日</button>
        <button class="del-btn" data-del-food="${esc(food.id)}">删除</button>
      </div>
      <div class="quick-add hidden" data-quick-form="${esc(food.id)}">
        <select data-quick-meal>
          <option value="早餐">早餐</option>
          <option value="午餐" selected>午餐</option>
          <option value="晚餐">晚餐</option>
          <option value="加餐">加餐</option>
        </select>
        <input type="number" data-quick-weight value="${round(food.weight_g)}" step="1" min="1" inputmode="numeric">
        <span class="muted">g</span>
        <button class="small-btn" data-quick-add="${esc(food.id)}">添加</button>
      </div>
    </div>`;
  }).join('');
}

async function saveFood() {
  const name = $('#foodName').value.trim();
  const weight = num($('#foodWeight').value);
  if (!name) { setFoodStatus('请填写食物名称。', 'error'); return; }
  if (weight <= 0) { setFoodStatus('请填写一份重量（克）。', 'error'); return; }
  const old = editingFoodId ? allCustomFoods.find((f) => f.id === editingFoodId) : null;
  const record = {
    id: editingFoodId || uid(),
    name,
    weight_g: weight,
    per100: {
      calories_kcal: num($('#foodKcal').value),
      protein_g: num($('#foodProtein').value),
      carbs_g: num($('#foodCarbs').value),
      fat_g: num($('#foodFat').value)
    },
    labelImage: pendingFoodLabel || '',
    createdAt: old ? old.createdAt : Date.now()
  };
  await idbPut('customFoods', record);
  allCustomFoods = await idbAll('customFoods');
  renderCustomFoods();
  refreshManualDatalist();
  resetFoodForm();
  setFoodStatus('已保存 ✓', 'ok');
}

async function addCustomFoodToMeal(food, weightG, mealType) {
  const factor = weightG / 100;
  const p = food.per100 || {};
  const foodItem = {
    name: food.name,
    weight_g: round(weightG),
    calories_kcal: round(num(p.calories_kcal) * factor),
    protein_g: round(num(p.protein_g) * factor),
    carbs_g: round(num(p.carbs_g) * factor),
    fat_g: round(num(p.fat_g) * factor)
  };
  const now = new Date();
  const meal = {
    id: uid(),
    date: currentDate,
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    mealType,
    foods: [foodItem],
    totals: {
      calories_kcal: foodItem.calories_kcal,
      protein_g: foodItem.protein_g,
      carbs_g: foodItem.carbs_g,
      fat_g: foodItem.fat_g
    },
    notes: `来自食物库：${food.name}`,
    thumb: '',
    visionRaw: ''
  };
  await idbPut('meals', meal);
  allMeals.push(meal);
  refreshToday();
  renderHistory();
}

/* ============ 导出 / 导入 ============ */
async function exportData() {
  const meals = await idbAll('meals');
  const body = await idbAll('body');
  const data = {
    app: 'foodlens',
    exportedAt: new Date().toISOString(),
    plan: settings.plan,
    targets: settings.targets,
    user: settings.user,
    refCard: settings.refCard,
    glmModel: settings.glmModel,
    dsModel: settings.dsModel,
    meals,
    body,
    customFoods,
    useWeekTargets: settings.useWeekTargets,
    weekTargets: settings.weekTargets
  };
  const fileName = `foodlens-backup-${localDateString()}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  // iOS PWA 里程序化下载经常无效，优先用系统分享面板（可存到“文件”、微信、AirDrop）
  if (navigator.canShare && navigator.canShare({ files: [new File([blob], fileName, { type: 'application/json' })] })) {
    try {
      await navigator.share({
        files: [new File([blob], fileName, { type: 'application/json' })],
        title: '轻食Lens 备份'
      });
      setStatus('#settingsStatus', '备份已分享 ✓', 'ok');
      return;
    } catch (error) {
      // 用户取消分享时继续走下载兜底
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  try {
    window.open(url, '_blank');
  } catch (error) { /* 部分环境禁止弹窗，忽略 */ }
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  $('#backupOutput').value = JSON.stringify(data, null, 2);
  $('#backupOutput').classList.remove('hidden');
  $('#copyBackupBtn').classList.remove('hidden');
  setStatus('#settingsStatus', '若没有弹出分享/下载，请点「复制备份内容」，粘贴到备忘录或“文件”保存为 .json 再导入。', 'ok');
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'foodlens') throw new Error('不是有效的备份文件');
    if (Array.isArray(data.meals)) {
      for (const meal of data.meals) await idbPut('meals', meal);
    }
    if (Array.isArray(data.body)) {
      for (const record of data.body) await idbPut('body', record);
    }
    if (Array.isArray(data.customFoods)) {
      for (const food of data.customFoods) await idbPut('customFoods', food);
    }
    if (data.plan !== undefined) settings.plan = data.plan;
    if (data.targets) settings.targets = Object.assign(settings.targets, data.targets);
    if (data.refCard) settings.refCard = Object.assign(settings.refCard, data.refCard);
    if (data.glmModel) settings.glmModel = data.glmModel;
    if (data.dsModel) settings.dsModel = data.dsModel;
    if (data.glmKey) settings.glmKey = data.glmKey;
    if (data.dsKey) settings.dsKey = data.dsKey;
    if (data.useWeekTargets !== undefined) settings.useWeekTargets = !!data.useWeekTargets;
    if (data.weekTargets) settings.weekTargets = Object.assign(settings.weekTargets, data.weekTargets);
    if (data.user) settings.user = Object.assign(settings.user, data.user);
    saveSettings();
    await loadAllData();
    setStatus('#settingsStatus', '导入成功 ✓', 'ok');
  } catch (error) {
    setStatus('#settingsStatus', '导入失败：' + error.message, 'error');
  }
}

/* ============ 设置界面 ============ */
function renderWeekTargetsForm() {
  const wrap = $('#weekTargetsWrap');
  if (!wrap) return;
  wrap.classList.toggle('hidden', !settings.useWeekTargets);
  wrap.innerHTML = DAY_META.map((day) => {
    const t = settings.weekTargets[day.key] || settings.targets;
    return `<div class="week-target-row">
      <span class="day-label">${day.label}</span>
      <input type="number" data-day="${day.key}" data-nut="calories" value="${t.calories}" placeholder="热量" inputmode="numeric">
      <input type="number" data-day="${day.key}" data-nut="protein" value="${t.protein}" placeholder="蛋白" inputmode="decimal">
      <input type="number" data-day="${day.key}" data-nut="carbs" value="${t.carbs}" placeholder="碳水" inputmode="decimal">
      <input type="number" data-day="${day.key}" data-nut="fat" value="${t.fat}" placeholder="脂肪" inputmode="decimal">
    </div>`;
  }).join('');
}

function fillSettingsForm() {
  $('#glmKey').value = settings.glmKey;
  $('#glmModel').value = settings.glmModel;
  $('#dsKey').value = settings.dsKey;
  $('#dsModel').value = settings.dsModel;
  $('#refType').value = settings.refCard.type;
  $('#refLen').value = settings.refCard.len;
  $('#refWid').value = settings.refCard.wid;
  $('#useWeekTargets').checked = !!settings.useWeekTargets;
  renderWeekTargetsForm();
  $('#targetCal').value = settings.targets.calories;
  $('#targetProtein').value = settings.targets.protein;
  $('#targetCarbs').value = settings.targets.carbs;
  $('#targetFat').value = settings.targets.fat;
  $('#userWeight').value = settings.user.weight;
  $('#userHeight').value = settings.user.height;
  $('#planText').value = settings.plan;
}

function collectSettingsForm() {
  settings.glmKey = $('#glmKey').value.trim();
  settings.glmModel = $('#glmModel').value.trim() || 'glm-4.6v-flash';
  settings.dsKey = $('#dsKey').value.trim();
  settings.dsModel = $('#dsModel').value.trim() || 'deepseek-v4-flash';
  settings.refCard = {
    type: $('#refType').value,
    len: num($('#refLen').value) || 11.2,
    wid: num($('#refWid').value) || 6.8
  };
  settings.useWeekTargets = !!$('#useWeekTargets').checked;
  if (settings.useWeekTargets) {
    document.querySelectorAll('#weekTargetsWrap input').forEach((input) => {
      const day = input.dataset.day;
      const nut = input.dataset.nut;
      if (!day || !nut) return;
      if (!settings.weekTargets[day]) settings.weekTargets[day] = {};
      settings.weekTargets[day][nut] = num(input.value);
    });
  }
  settings.targets = {
    calories: num($('#targetCal').value) || 1800,
    protein: num($('#targetProtein').value) || 120,
    carbs: num($('#targetCarbs').value) || 180,
    fat: num($('#targetFat').value) || 60
  };
  settings.user = {
    weight: $('#userWeight').value.trim(),
    height: $('#userHeight').value.trim()
  };
  saveSettings();
}

async function testApi(url, key, model, statusText) {
  if (!key) {
    setStatus('#settingsStatus', '请先填写对应的 API Key。', 'error');
    return;
  }
  setStatus('#settingsStatus', `正在测试 ${statusText}…`, 'loading');
  try {
    const reply = await apiChat(url, key, model, [{ role: 'user', content: '只回复两个字：正常' }], { maxTokens: 16 });
    setStatus('#settingsStatus', `${statusText} 连接正常 ✓ 模型返回：${reply.slice(0, 30)}`, 'ok');
  } catch (error) {
    setStatus('#settingsStatus', `${statusText} 测试失败：${error.message}`, 'error');
  }
}

/* ============ 数据加载 ============ */
async function loadAllData() {
  allMeals = await idbAll('meals');
  allBody = await idbAll('body');
  allCustomFoods = await idbAll('customFoods');
  settings = loadSettings();
  fillSettingsForm();
  updateRefHint();
  refreshManualDatalist();
  renderManualList();
  renderTodayTotals();
  renderTodayMeals();
  renderHistory();
  renderBody();
  renderCustomFoods();
}

function updateRefHint() {
  const type = $('#refType').value;
  if (type === 'idcard') {
    $('#captureHint').textContent = '已开启参照物：第一张请俯拍，身份证/银行卡平放食物旁';
  } else if (type === 'custom') {
    const len = num($('#refLen').value) || num(settings.refCard.len) || 11.2;
    $('#captureHint').textContent = `已开启参照物：第一张请俯拍，长${len}cm 的卡片平放食物旁（挂扣藏背面）`;
  } else {
    $('#captureHint').textContent = '第一张：俯视图（可把工牌平放旁边）';
  }
}

async function handleFoodLabelFile(file) {
  if (!file) return;
  if (!settings.glmKey) {
    setFoodStatus('需要先配置 GLM API Key 才能识别营养成分表。', 'error');
    return;
  }
  try {
    const dataUrl = await fileToDataURL(file, 1280, 0.85);
    pendingFoodLabel = dataUrl;
    $('#foodLabelPreview').innerHTML = `<img src="${dataUrl}" alt="营养成分表">`;
    $('#foodLabelPreview').classList.remove('hidden');
    setFoodStatus('GLM 正在读取营养成分表…', 'loading');
    const text = await glmVision([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: NUTRITION_PROMPT }
        ]
      }
    ]);
    const parsed = extractJson(text);
    if (parsed && parsed.per100) {
      let kcal = parsed.per100.calories_kcal;
      if (kcal !== undefined && num(kcal) > 700) {
        // 模型常把包装上的 kJ 当成 kcal，自动换算
        kcal = Math.round(num(kcal) / 4.184);
        setFoodStatus('已自动填入（能量原为 kJ，已换算成 kcal），请核对后保存 ✓', 'ok');
      } else if (kcal !== undefined) {
        setFoodStatus('已自动填入，请核对数值后保存 ✓', 'ok');
      }
      if (kcal !== undefined) $('#foodKcal').value = kcal;
      if (parsed.per100.protein_g !== undefined) $('#foodProtein').value = parsed.per100.protein_g;
      if (parsed.per100.carbs_g !== undefined) $('#foodCarbs').value = parsed.per100.carbs_g;
      if (parsed.per100.fat_g !== undefined) $('#foodFat').value = parsed.per100.fat_g;
      if (parsed.serving_size_g && !$('#foodWeight').value) $('#foodWeight').value = parsed.serving_size_g;
    } else {
      setFoodStatus('未能从图片解析出营养成分，请手动填写。', 'error');
    }
  } catch (error) {
    setFoodStatus('识别失败：' + error.message, 'error');
  }
}

async function handleFoodListClick(event) {
  const editBtn = event.target.closest('[data-edit-food]');
  if (editBtn) {
    const food = allCustomFoods.find((f) => f.id === editBtn.dataset.editFood);
    if (!food) return;
    editingFoodId = food.id;
    pendingFoodLabel = food.labelImage || null;
    $('#foodName').value = food.name;
    $('#foodWeight').value = food.weight_g;
    $('#foodKcal').value = food.per100 ? food.per100.calories_kcal : '';
    $('#foodProtein').value = food.per100 ? food.per100.protein_g : '';
    $('#foodCarbs').value = food.per100 ? food.per100.carbs_g : '';
    $('#foodFat').value = food.per100 ? food.per100.fat_g : '';
    if (pendingFoodLabel) {
      $('#foodLabelPreview').innerHTML = `<img src="${pendingFoodLabel}" alt="营养成分表">`;
      $('#foodLabelPreview').classList.remove('hidden');
    } else {
      $('#foodLabelPreview').classList.add('hidden');
      $('#foodLabelPreview').innerHTML = '';
    }
    $('#addFoodBtn').textContent = '保存修改';
    setFoodStatus('正在编辑：' + food.name, '');
    return;
  }
  const delBtn = event.target.closest('[data-del-food]');
  if (delBtn) {
    if (!window.confirm('删除这个自定义食物？')) return;
    await idbDelete('customFoods', delBtn.dataset.delFood);
    allCustomFoods = await idbAll('customFoods');
    renderCustomFoods();
    refreshManualDatalist();
    return;
  }
  const quickBtn = event.target.closest('[data-quick-food]');
  if (quickBtn) {
    const form = document.querySelector(`[data-quick-form="${quickBtn.dataset.quickFood}"]`);
    if (form) form.classList.toggle('hidden');
    return;
  }
  const addBtn = event.target.closest('[data-quick-add]');
  if (addBtn) {
    const food = allCustomFoods.find((f) => f.id === addBtn.dataset.quickAdd);
    const wrap = addBtn.closest('.quick-add');
    if (!food || !wrap) return;
    const weight = num(wrap.querySelector('[data-quick-weight]').value);
    if (weight <= 0) { setFoodStatus('克重无效。', 'error'); return; }
    const mealType = wrap.querySelector('[data-quick-meal]').value;
    await addCustomFoodToMeal(food, weight, mealType);
    wrap.classList.add('hidden');
    setFoodStatus('已加到今日 ✓', 'ok');
  }
}

/* ============ 事件绑定 ============ */
function bindEvents() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.view').forEach((v) => v.classList.remove('active'));
      tab.classList.add('active');
      $('#view-' + tab.dataset.view).classList.add('active');
      if (tab.dataset.view === 'history') renderHistory();
      if (tab.dataset.view === 'foods') renderCustomFoods();
      if (tab.dataset.view === 'body') renderBody();
    });
  });

  $('#dayPicker').value = currentDate;
  $('#dayPicker').addEventListener('change', () => {
    currentDate = $('#dayPicker').value || localDateString();
    $('#dayPicker').value = currentDate;
    pendingResult = null;
    $('#analysisResult').classList.add('hidden');
    refreshToday();
  });
  $('#prevDay').addEventListener('click', () => {
    const date = new Date(currentDate + 'T00:00:00');
    date.setDate(date.getDate() - 1);
    currentDate = localDateString(date);
    $('#dayPicker').value = currentDate;
    refreshToday();
  });
  $('#nextDay').addEventListener('click', () => {
    const date = new Date(currentDate + 'T00:00:00');
    date.setDate(date.getDate() + 1);
    currentDate = localDateString(date);
    $('#dayPicker').value = currentDate;
    refreshToday();
  });

  async function handleMainPhotoFile(file) {
    if (!file) return;
    try {
      pendingImageDataUrl = await fileToDataURL(file, 1280, 0.85);
      $('#photoPreview').src = pendingImageDataUrl;
      $('#photoPreviewWrap').classList.remove('hidden');
      $('#captureHint').textContent = '已选择图片，点击下方按钮分析';
      $('#analyzeBtn').disabled = false;
      setStatus('#analyzeStatus', '', '');
    } catch (error) {
      setStatus('#analyzeStatus', '图片读取失败：' + error.message, 'error');
    }
  }
  $('#photoInput').addEventListener('change', (event) => handleMainPhotoFile(event.target.files && event.target.files[0]));
  $('#photoAlbumInput').addEventListener('change', (event) => handleMainPhotoFile(event.target.files && event.target.files[0]));

  $('#clearPhoto').addEventListener('click', () => {
    pendingImageDataUrl = null;
    pendingImageDataUrl2 = null;
    pendingResult = null;
    $('#photoInput').value = '';
    $('#photoInput2').value = '';
    $('#photoAlbumInput').value = '';
    $('#photoAlbumInput2').value = '';
    $('#photoPreviewWrap').classList.add('hidden');
    $('#photoPreviewWrap2').classList.add('hidden');
    $('#captureHint2').textContent = '＋第二视角（前上45°，工牌和食物都别动，可选）';
    $('#analyzeBtn').disabled = true;
    $('#analysisResult').classList.add('hidden');
    $('#captureHint').textContent = '拍照或选择食物图片';
    setStatus('#analyzeStatus', '', '');
  });

  async function handleSidePhotoFile(file) {
    if (!file) return;
    try {
      pendingImageDataUrl2 = await fileToDataURL(file, 1280, 0.85);
      $('#photoPreview2').src = pendingImageDataUrl2;
      $('#photoPreviewWrap2').classList.remove('hidden');
      $('#captureHint2').textContent = '已添加第二视角 ✓（保持工牌与食物位置不动）';
    } catch (error) {
      setStatus('#analyzeStatus', '第二视角图片读取失败：' + error.message, 'error');
    }
  }
  $('#photoInput2').addEventListener('change', (event) => handleSidePhotoFile(event.target.files && event.target.files[0]));
  $('#photoAlbumInput2').addEventListener('change', (event) => handleSidePhotoFile(event.target.files && event.target.files[0]));

  $('#clearPhoto2').addEventListener('click', () => {
    pendingImageDataUrl2 = null;
    $('#photoInput2').value = '';
    $('#photoAlbumInput2').value = '';
    $('#photoPreviewWrap2').classList.add('hidden');
    $('#captureHint2').textContent = '＋第二视角（前上45°，工牌和食物都别动，可选）';
  });

  async function handleLeftoverPhotoFile(file) {
    if (!file) return;
    try {
      leftoverImageDataUrl = await fileToDataURL(file, 1280, 0.85);
      $('#leftoverPreview').src = leftoverImageDataUrl;
      $('#leftoverPreviewWrap').classList.remove('hidden');
      $('#leftoverHint').textContent = '已选择剩余俯视图 ✓';
    } catch (error) {
      setLeftoverStatus('图片读取失败：' + error.message, 'error');
    }
  }
  async function handleLeftoverPhotoFile2(file) {
    if (!file) return;
    try {
      leftoverImageDataUrl2 = await fileToDataURL(file, 1280, 0.85);
      $('#leftoverPreview2').src = leftoverImageDataUrl2;
      $('#leftoverPreviewWrap2').classList.remove('hidden');
      $('#leftoverHint2').textContent = '已选择剩余45° ✓';
    } catch (error) {
      setLeftoverStatus('图片读取失败：' + error.message, 'error');
    }
  }
  $('#leftoverInput').addEventListener('change', (event) => handleLeftoverPhotoFile(event.target.files && event.target.files[0]));
  $('#leftoverAlbumInput').addEventListener('change', (event) => handleLeftoverPhotoFile(event.target.files && event.target.files[0]));
  $('#leftoverInput2').addEventListener('change', (event) => handleLeftoverPhotoFile2(event.target.files && event.target.files[0]));
  $('#leftoverAlbumInput2').addEventListener('change', (event) => handleLeftoverPhotoFile2(event.target.files && event.target.files[0]));
  $('#clearLeftover').addEventListener('click', () => {
    leftoverImageDataUrl = null;
    $('#leftoverInput').value = '';
    $('#leftoverAlbumInput').value = '';
    $('#leftoverPreviewWrap').classList.add('hidden');
    $('#leftoverHint').textContent = '剩余：俯视图（工牌平放旁边）';
  });
  $('#clearLeftover2').addEventListener('click', () => {
    leftoverImageDataUrl2 = null;
    $('#leftoverInput2').value = '';
    $('#leftoverAlbumInput2').value = '';
    $('#leftoverPreviewWrap2').classList.add('hidden');
    $('#leftoverHint2').textContent = '剩余：前上45°（可选，工牌和食物都别动）';
  });
  $('#leftoverAnalyzeBtn').addEventListener('click', runLeftoverAnalysis);
  $('#applyLeftoverBtn').addEventListener('click', computeEatenFromLeftover);

  $('#analyzeBtn').addEventListener('click', runAnalysis);
  $('#textAnalyzeBtn').addEventListener('click', runTextAnalysis);
  $('#evaluateBtn').addEventListener('click', runEvaluate);

  $('#manualAddBtn').addEventListener('click', addManualFood);
  $('#manualClearBtn').addEventListener('click', clearManualList);
  $('#manualSaveBtn').addEventListener('click', saveManualMeal);
  $('#manualMealType').addEventListener('change', () => {
    if (manualFoods.length) {
      $('#manualSaveBtn').textContent = `✓ 保存为「${$('#manualMealType').value}」记录`;
    }
  });
  $('#manualList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-manual-del]');
    if (!button) return;
    manualFoods.splice(parseInt(button.dataset.manualDel, 10), 1);
    renderManualList();
    setManualStatus('', '');
  });
  $('#manualName').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addManualFood();
    }
  });

  $('#todayMeals').addEventListener('click', async (event) => {
    const editBtn = event.target.closest('[data-edit-meal]');
    if (editBtn) {
      editMeal(editBtn.dataset.editMeal);
      return;
    }
    const button = event.target.closest('[data-del-meal]');
    if (!button) return;
    const id = button.dataset.delMeal;
    await idbDelete('meals', id);
    allMeals = allMeals.filter((meal) => meal.id !== id);
    refreshToday();
    renderHistory();
  });

  $('#bodyList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-del-body]');
    if (!button) return;
    await idbDelete('body', button.dataset.delBody);
    allBody = await idbAll('body');
    renderBody();
  });

  $('#bodyDate').value = localDateString();
  $('#saveBodyBtn').addEventListener('click', async () => {
    const date = $('#bodyDate').value || localDateString();
    const record = {
      id: date,
      date,
      weight: $('#bodyWeight').value.trim(),
      chest: $('#bodyChest').value.trim(),
      waist: $('#bodyWaist').value.trim(),
      hip: $('#bodyHip').value.trim()
    };
    if (!record.weight && !record.chest && !record.waist && !record.hip) {
      setStatus('#bodyList', '至少填写一项数据。', 'error');
      return;
    }
    await idbPut('body', record);
    allBody = await idbAll('body');
    $('#bodyWeight').value = $('#bodyChest').value = $('#bodyWaist').value = $('#bodyHip').value = '';
    renderBody();
  });

  $('#savePlanBtn').addEventListener('click', () => {
    settings.plan = $('#planText').value;
    saveSettings();
    $('#planStatus').textContent = '计划已保存 ✓';
    $('#planStatus').className = 'status ok';
  });

  $('#saveSettingsBtn').addEventListener('click', () => {
    collectSettingsForm();
    $('#settingsStatus').textContent = '设置已保存 ✓';
    $('#settingsStatus').className = 'status ok';
    renderTodayTotals();
  });
  $('#useWeekTargets').addEventListener('change', () => {
    $('#weekTargetsWrap').classList.toggle('hidden', !$('#useWeekTargets').checked);
  });

  $('#testGlmBtn').addEventListener('click', () => {
    collectSettingsForm();
    testApi(settings.glmUrl, settings.glmKey, settings.glmModel, 'GLM');
  });
  $('#testDsBtn').addEventListener('click', () => {
    collectSettingsForm();
    testApi(settings.dsUrl, settings.dsKey, settings.dsModel, 'DeepSeek');
  });
  $('#refType').addEventListener('change', updateRefHint);
  $('#refLen').addEventListener('input', updateRefHint);
  $('#refWid').addEventListener('input', updateRefHint);
  $('#addFoodBtn').addEventListener('click', saveFood);
  $('#foodSearch').addEventListener('input', () => renderCustomFoods());
  $('#foodLabelInput').addEventListener('change', (event) => handleFoodLabelFile(event.target.files && event.target.files[0]));
  $('#foodLabelAlbumInput').addEventListener('change', (event) => handleFoodLabelFile(event.target.files && event.target.files[0]));
  $('#foodList').addEventListener('click', handleFoodListClick);

  $('#exportBtn').addEventListener('click', exportData);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#copyBackupBtn').addEventListener('click', async () => {
    const text = $('#backupOutput').value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      $('#backupOutput').select();
      document.execCommand('copy');
    }
    setStatus('#settingsStatus', '备份内容已复制 ✓ 粘贴到备忘录/文件，保存为 .json 后即可导入。', 'ok');
  });
  $('#importFile').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) importData(file);
    event.target.value = '';
  });
}

/* ============ 启动 ============ */
document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  try {
    await loadWeightRefs();
    await loadAllData();
  } catch (error) {
    console.error('数据加载失败', error);
  }
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service Worker 注册失败', error));
  }
});
