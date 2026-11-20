// dsh-chatterbox — browser half.
//
// Two jobs:
//  1. the row's configuration page (Plugins → dsh-chatterbox → row chatterbox)
//     with an editable 「出声 SKILL 路径」 field;
//  2. the composer's 「自由麦克风」 master switch, seated in
//     `conversation.input.left` right after the Computer Use control.
//
// The toggle talks to the Host plugin's own loopback listener (the same one the
// voice client posts to), because this bundle carries no generated remotes.
// Bundled in the lazy-CJS shape the DSH client module loader expects; only React
// is required from the page.
window.__ModuleLoader__.load({id:"dsh-chatterbox",factory:(require)=>{
const modules={"client/index.js":{imports:{},run(module,exports,require){
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.name = 'dsh-chatterbox';
exports.inject = ['slots'];
exports.apply = apply;

const React = require("react");

const h = React.createElement;
const hFragment = React.Fragment;
const FIELD = 'speakSkillPath';
const TITLE = '出声 SKILL 路径';
const INGEST = 'http://127.0.0.1:18801';

const labelStyle = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
};
const hintStyle = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)',
};
const inputStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'inherit',
  fontSize: 13,
};
const buttonStyle = {
  flex: '0 0 auto',
  padding: '7px 14px',
  borderRadius: 8,
  border: '1px solid transparent',
  background: 'var(--dsw-alias-brand-primary)',
  color: 'var(--dsw-alias-bg-base)',
  fontSize: 13,
  cursor: 'pointer',
};
const buttonDisabledStyle = {
  ...buttonStyle,
  background: 'var(--dsw-alias-border-l1)',
  color: 'var(--dsw-alias-state-idle-primary)',
  cursor: 'default',
};

/** The editable settings of this row. Number inputs carry their own width so a
 *  two-digit value does not get a full-width box. */
const FIELDS = [
  {
    key: 'speakSkillPath',
    id: 'chatterbox-speak-skill-path',
    label: '音色档案（出声）',
    hint: '选中的就是 voices\\cb_* 里的成品音色档案：目录里的 SKILL.md 定义怎么念，voice.json 给出档案 id。换一个档案就换一种声音；在任意会话里说「念出来」用的也是它。',
    kind: 'select',
    width: 300,
  },
  {
    key: 'agentPreset',
    id: 'chatterbox-agent-preset',
    label: '回答用的 agent（预设）',
    hint: '从 DSH 的预设注册表里选：决定这个语音会话由哪个角色作答（性格、称呼都来自该预设）。留空=跟随目标会话；指定后只对**新建**的语音会话生效，已有的会话不会被改。',
    kind: 'select',
    width: 300,
  },
  {
    key: 'agentPersona',
    id: 'chatterbox-agent-persona',
    label: '回复格式（persona）',
    hint: '只决定回复的段落格式与称呼措辞（例如 my-hero=三段、deepseek=两段）。默认跟随 agent 预设：同名的 personas/<预设 id>.json 会自动生效（目录只有一个：<插件>\personas\）。',
    kind: 'select',
    width: 300,
  },
  {
    key: 'sessionId',
    id: 'chatterbox-session',
    label: '输出会话',
    hint: '语音投递到哪个会话。选「自动」则按最近活跃的那个；改完保存后立刻生效，不必重载插件。',
    kind: 'select',
    width: 300,
  },
  {
    key: 'asrLanguage',
    id: 'chatterbox-asr-language',
    label: '识别语言',
    hint: '语音转文字用的语言。auto 会自动判断（中文 / English / 日本語 / 한국어 / 粵語）；固定成你常说的语言更准。改完约 1 秒重开语音端，下一句生效。',
    kind: 'select',
    width: 200,
    options: [
      { value: 'auto', label: '自动识别（默认）' },
      { value: 'zh', label: '普通话' },
      { value: 'en', label: 'English' },
      { value: 'ja', label: '日本語' },
      { value: 'ko', label: '한국어' },
      { value: 'yue', label: '粵語' },
    ],
  },
  {
    key: 'hotkey',
    id: 'chatterbox-hotkey',
    label: '按住说话按键',
    hint: '按住的这个键（可以是组合键）说话，松开结束。点「录制按键」再按一下要用的键即可；也可以手写，例如 printscreen、f9、ctrl+alt+space、shift+mouse4。改完约 1 秒重开语音端。',
    kind: 'text',
    capture: true,
    placeholder: 'printscreen',
    width: 220,
  },
  {
    key: 'vadSilenceSeconds',
    id: 'chatterbox-vad-silence',
    label: '投送延迟',
    hint: '静默超过这么多秒才算一句说完并投送，范围 0.3–600，最多 1 位小数。默认 2；调小更灵敏。',
    kind: 'number',
    min: 0.3,
    max: 600,
    step: 0.1,
    decimals: 1,
    width: 74,
  },
  {
    key: 'leadInSeconds',
    id: 'chatterbox-lead-in',
    label: '开头补静音（秒）',
    hint: '为什么存在：模型生成的音频从第一个采样点就出声，而蓝牙耳机、声卡「起播」有几十到几百毫秒的启动延迟——不补静音，第一个音会被吞掉半截。0.2 秒通常够；还被吞就调到 0.3。改完下一句生效。',
    kind: 'number',
    min: 0,
    max: 2,
    step: 0.01,
    decimals: 2,
    width: 84,
  },
  {
    key: 'tailSeconds',
    id: 'chatterbox-tail',
    label: '结尾补静音（秒）',
    hint: '收尾同理：末尾留一点静音，避免最后一个音被切断。默认 0.12。',
    kind: 'number',
    min: 0,
    max: 2,
    step: 0.01,
    decimals: 2,
    width: 84,
  },
  {
    key: 'audioRetentionDays',
    id: 'chatterbox-retention',
    label: '音频保留天数',
    hint: '插件把音频写在 out\\ 里；超过这么多天的会被移入回收站（0 = 不清理，keep_ 开头永不清理）。默认 3 天，保存即生效，插件下一次扫描时执行。',
    kind: 'number',
    integer: true,
    min: 0,
    max: 365,
    step: 1,
    width: 74,
  },
  {
    key: 'replyMaxChars',
    id: 'chatterbox-reply-max-chars',
    label: '回复长度上限（字）',
    hint: '语音文本最多多少字，整数；0 = 不限。调小出声更快，调大更像闲聊。',
    kind: 'number',
    integer: true,
    min: 0,
    max: 500,
    step: 1,
    width: 84,
  },
];

const asDraft = (field, raw) => {
  if (field.kind === 'number') return raw === undefined || raw === null ? '' : String(raw);
  return typeof raw === 'string' ? raw : '';
};

/** Options for the 音色档案 dropdown: the current folder first, then the rest. */
const voiceOptions = (list, current) => {
  const options = [];
  const seen = new Set();
  for (const item of list.items) {
    if (typeof item.folder !== 'string' || seen.has(item.folder)) continue;
    seen.add(item.folder);
    options.push({ value: item.folder, label: (item.label || item.profile || item.folder) + (item.profile ? ' · ' + item.profile : '') });
  }
  if (current !== '' && !seen.has(current)) {
    options.unshift({ value: current, label: current + '（当前，不在列表里）' });
  }
  return options;
};

/** Options for the 回答用的 agent 预设 dropdown: platform default + DSH's roster. */
const presetOptions = (list, current) => {
  const options = [{ value: '', label: '跟随目标会话（不指定）' }];
  const seen = new Set(['']);
  for (const item of list.items) {
    if (typeof item.id !== 'string' || seen.has(item.id)) continue;
    seen.add(item.id);
    const marks = [];
    if (item.isDefault) marks.push('平台默认');
    if (item.broken) marks.push('加载失败');
    options.push({
      value: item.id,
      label: (item.name || item.id) + '（' + item.id + '）' + (marks.length > 0 ? ' · ' + marks.join(' / ') : ''),
    });
  }
  if (current !== '' && !seen.has(current)) {
    options.unshift({ value: current, label: current + '（当前，不在注册表里）' });
  }
  return options;
};

/** Options for the 回复格式 dropdown: follow the preset + personas, then local ones. */
const personaOptions = (list, current) => {
  const options = [{ value: '', label: '跟随 agent 预设（推荐）' }];
  const seen = new Set();
  for (const item of list.items) {
    if (typeof item.id !== 'string' || seen.has(item.id)) continue;
    seen.add(item.id);
    const source = item.source ? ' · ' + item.source : '';
    options.push({ value: item.id, label: (item.display || item.id) + (item.id ? '（' + item.id + '）' : '') + source });
  }
  if (current !== '' && !seen.has(current)) {
    options.push({ value: current, label: current + '（当前，不在列表里）' });
  }
  return options;
};

/** Options for the 输出会话 dropdown: current value first, then the Host list. */
const sessionOptions = (list, current) => {
  const options = [{ value: '', label: '自动（按最近活跃）' }];
  const seen = new Set(['']);
  for (const item of list.items) {
    if (typeof item.sessionId !== 'string' || seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    const mark = item.live === false ? '（未打开）' : '';
    options.push({ value: item.sessionId, label: (item.label || item.sessionId) + mark });
  }
  if (current !== '' && !seen.has(current)) {
    options.unshift({ value: current, label: current + '（当前，不在列表里）' });
  }
  return options;
};

/** Key names the voice client understands (keyboard-lib names + our specials). */
const HOTKEY_MODIFIERS = ['ctrl', 'alt', 'shift', 'win', 'windows'];
const HOTKEY_KEYS = new Set([
  'space', 'enter', 'tab', 'esc', 'escape', 'backspace', 'delete', 'insert',
  'home', 'end', 'page up', 'page down', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'printscreen', 'prtsc', 'print', 'scrolllock', 'pause',
  'mouse4', 'mouse5', 'x1', 'x2', 'back', 'forward', '-', '=', '`', '[', ']', ';', "'", ',', '.', '/',
  String.fromCharCode(92),
  ...Array.from({ length: 24 }, (_, index) => 'f' + String(index + 1)),
]);

/** null when usable, otherwise the message shown under the field. */
const hotkeyProblem = (raw) => {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === '') return '按住说话按键不能为空';
  const parts = text.split('+').map((part) => part.trim()).filter((part) => part.length > 0);
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (!/^[a-z0-9]$/.test(key) && !HOTKEY_KEYS.has(key)) {
    return '不认识的键名：' + key + '（可用 a–z、0–9、f1–f24、space、insert、mouse4…）';
  }
  if (!mods.every((mod) => HOTKEY_MODIFIERS.includes(mod))) return '组合键里只能用 ctrl / alt / shift / win';
  if (new Set(mods).size !== mods.length) return '组合键里有重复的修饰键';
  return null;
};

/** KeyboardEvent.code -> the voice client's key name. */
const CODE_KEYS = {
  Space: 'space', Enter: 'enter', Tab: 'tab', Escape: 'esc', Backspace: 'backspace',
  Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
  PageUp: 'page up', PageDown: 'page down',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  PrintScreen: 'printscreen', ScrollLock: 'scrolllock', Pause: 'pause',
  Minus: '-', Equal: '=', Backquote: '`', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  Backslash: String.fromCharCode(92),
};
const keyNameFromCode = (code) => {
  if (CODE_KEYS[code] !== undefined) return CODE_KEYS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
  return null;
};
/** Render the settings form for this row. */
function SettingsForm(props) {
  const form = props.form;
  const state = form && form.state ? form.state : undefined;
  const value = state && state.value && typeof state.value === 'object' ? state.value : {};
  const [draft, setDraft] = React.useState(() => {
    const initial = {};
    for (const field of FIELDS) initial[field.key] = asDraft(field, value[field.key]);
    return initial;
  });
  const [busy, setBusy] = React.useState(false);
  const [capturing, setCapturing] = React.useState(null);
  const [message, setMessage] = React.useState(null);
  const [sessionList, setSessionList] = React.useState({ loading: true, items: [], error: null });
  const [listReload, setListReload] = React.useState(0);
  const [voiceList, setVoiceList] = React.useState({ loading: true, items: [], error: null });
  const [voiceReload, setVoiceReload] = React.useState(0);
  const [personaList, setPersonaList] = React.useState({ loading: true, items: [], error: null });
  const [personaReload, setPersonaReload] = React.useState(0);
  const [presetList, setPresetList] = React.useState({ loading: true, items: [], error: null });
  const [presetReload, setPresetReload] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`${INGEST}/voice/profiles`)
      .then((response) => response.json())
      .then((body) => {
        if (cancelled) return;
        setVoiceList({ loading: false, items: Array.isArray(body && body.items) ? body.items : [], error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        setVoiceList({ loading: false, items: [], error: String(error && error.message ? error.message : error) });
      });
    return () => { cancelled = true; };
  }, [voiceReload]);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`${INGEST}/voice/presets`)
      .then((response) => response.json())
      .then((body) => {
        if (cancelled) return;
        setPresetList({ loading: false, items: Array.isArray(body && body.items) ? body.items : [], error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        setPresetList({ loading: false, items: [], error: String(error && error.message ? error.message : error) });
      });
    return () => { cancelled = true; };
  }, [presetReload]);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`${INGEST}/voice/personas`)
      .then((response) => response.json())
      .then((body) => {
        if (cancelled) return;
        setPersonaList({ loading: false, items: Array.isArray(body && body.items) ? body.items : [], error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        setPersonaList({ loading: false, items: [], error: String(error && error.message ? error.message : error) });
      });
    return () => { cancelled = true; };
  }, [personaReload]);

  React.useEffect(() => {
    let cancelled = false;
    setSessionList((previous) => ({ ...previous, loading: true }));
    fetch(`${INGEST}/voice/sessions`)
      .then((response) => response.json())
      .then((body) => {
        if (cancelled) return;
        setSessionList({
          loading: false,
          items: Array.isArray(body && body.items) ? body.items : [],
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setSessionList({ loading: false, items: [], error: String(error && error.message ? error.message : error) });
      });
    return () => { cancelled = true; };
  }, [listReload]);

  React.useEffect(() => {
    setDraft(() => {
      const next = {};
      for (const field of FIELDS) next[field.key] = asDraft(field, value[field.key]);
      return next;
    });
  }, [value.speakSkillPath, value.agentPersona, value.agentPreset, value.hotkey, value.vadSilenceSeconds, value.replyMaxChars, value.sessionId]);

  // While capturing, the next usable key becomes the hotkey (Esc cancels).
  React.useEffect(() => {
    if (capturing === null) return undefined;
    const onKeyDown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape') { setCapturing(null); return; }
      const name = keyNameFromCode(event.code);
      if (name === null) return;
      const mods = [];
      if (event.ctrlKey) mods.push('ctrl');
      if (event.altKey) mods.push('alt');
      if (event.shiftKey) mods.push('shift');
      if (event.metaKey) mods.push('win');
      setDraft((previous) => ({ ...previous, [capturing]: [...mods, name].join('+') }));
      setCapturing(null);
      setMessage(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing]);
  if (props.view === 'summary') return h('span', null, '输出会话 + 音色档案 + 按住说话按键 + 投送延迟');

  if (form === undefined) {
    return h('p', { style: hintStyle }, '这个插件没有可编辑的配置。');
  }
  if (state === undefined || state.status === 'loading') {
    return h('p', { style: hintStyle }, '正在读取配置…');
  }
  if (state.status === 'unavailable') {
    return h('p', { style: hintStyle }, '当前客户端读不到这份配置。');
  }

  const operations = [];
  let problem = null;
  for (const field of FIELDS) {
    const accepted = asDraft(field, value[field.key]);
    const typed = String(draft[field.key] ?? '');
    if (field.kind === 'number') {
      const parsed = Number(typed.trim());
      const digits = typed.trim();
      const tooManyDecimals = field.decimals !== undefined
        && /\.\d+/.test(digits)
        && String(parsed) !== String(Number(parsed.toFixed(field.decimals)));
      const invalid = digits === ''
        || !Number.isFinite(parsed)
        || parsed < field.min
        || parsed > field.max
        || (field.integer === true && !Number.isInteger(parsed))
        || tooManyDecimals;
      if (invalid) {
        problem = field.integer === true
          ? `${field.label}必须是 ${field.min}–${field.max} 之间的整数`
          : field.decimals !== undefined
            ? `${field.label}必须是 ${field.min}–${field.max} 之间、最多 ${field.decimals} 位小数的数字`
            : `${field.label}必须是 ${field.min}–${field.max} 之间的数字`;
        continue;
      }
      if (field.decimals !== undefined) {
        const rounded = Number(parsed.toFixed(field.decimals));
        if (String(rounded) !== String(accepted)) operations.push({ op: 'set', path: [field.key], value: rounded });
        continue;
      }
      if (String(parsed) !== String(accepted)) operations.push({ op: 'set', path: [field.key], value: parsed });
    } else if (field.capture === true) {
      const trouble = hotkeyProblem(typed);
      if (trouble !== null) {
        problem = trouble;
        continue;
      }
      const clean = typed.trim().toLowerCase();
      if (clean !== accepted) operations.push({ op: 'set', path: [field.key], value: clean });
    } else if (typed.trim() !== accepted) {
      operations.push({ op: 'set', path: [field.key], value: typed.trim() });
    }
  }

  const writable = state.writable !== false;
  const dirty = operations.length > 0;
  const canSave = writable && dirty && problem === null && !busy;

  // The browser cannot stat the disk, so the Host checks the skill directory:
  // it must exist, be a directory, and carry SKILL.md.
  const checkSkillPath = (target) => fetch(`${INGEST}/voice/check-path`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: target }),
  }).then((response) => response.json());

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setMessage(null);
    try {
      const pathOperation = operations.find((operation) => operation.path[0] === 'speakSkillPath');
      if (pathOperation !== undefined) {
        let probe = null;
        try {
          probe = await checkSkillPath(pathOperation.value);
        } catch (error) {
          setMessage({ kind: 'err', text: '无法校验路径（Host 未响应）：' + String(error && error.message ? error.message : error) });
          return;
        }
        if (probe === null || probe.ok !== true) {
          const reason = probe === null || probe.exists === false
            ? '路径不存在'
            : probe.isDirectory === false
              ? '不是目录'
              : probe.hasSkillFile === false
                ? '目录里没有 SKILL.md'
                : '路径无效';
          setMessage({ kind: 'err', text: `${reason}：${pathOperation.value}` });
          return;
        }
      }
      const accepted = await form.mutate(operations, state.revision);
      setMessage(accepted
        ? { kind: 'ok', text: '已保存，下一轮投递生效。' }
        : { kind: 'err', text: 'Host 拒绝了这次写入（值未改动）。' });
    } catch (error) {
      setMessage({ kind: 'err', text: '写入失败：' + String(error && error.message ? error.message : error) });
    } finally {
      setBusy(false);
    }
  };

  const messageColor = message === null
    ? undefined
    : message.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)';



  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0 12px' } },
    ...FIELDS.map((field) => h('div', { key: field.key, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      h('label', { style: labelStyle, htmlFor: field.id }, field.label),
      field.kind === 'select'
        ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('select', {
              id: field.id,
              value: String(draft[field.key] ?? ''),
              disabled: !writable || busy,
              onChange: (event) => {
                setDraft((previous) => ({ ...previous, [field.key]: event.target.value }));
                setMessage(null);
              },
              style: { ...inputStyle, width: field.width ?? 300, flex: '0 0 auto', boxSizing: 'border-box' },
            }, (field.options !== undefined
              ? field.options
              : field.key === 'speakSkillPath'
                ? voiceOptions(voiceList, String(draft[field.key] ?? ''))
                : field.key === 'agentPersona'
                  ? personaOptions(personaList, String(draft[field.key] ?? ''))
                  : field.key === 'agentPreset'
                    ? presetOptions(presetList, String(draft[field.key] ?? ''))
                    : sessionOptions(sessionList, String(draft[field.key] ?? '')))
              .map((option) => h('option', { key: option.value, value: option.value }, option.label))),
            field.options !== undefined ? null : h('button', {
              type: 'button',
              disabled: (field.key === 'speakSkillPath' ? voiceList.loading
                : field.key === 'agentPersona' ? personaList.loading
                  : field.key === 'agentPreset' ? presetList.loading : sessionList.loading) === true,
              onClick: () => {
                if (field.key === 'speakSkillPath') setVoiceReload((count) => count + 1);
                else if (field.key === 'agentPersona') setPersonaReload((count) => count + 1);
                else if (field.key === 'agentPreset') setPresetReload((count) => count + 1);
                else setListReload((count) => count + 1);
              },
              style: { ...buttonStyle, padding: '4px 10px', fontSize: 12 },
            }, (field.key === 'speakSkillPath' ? voiceList.loading
              : field.key === 'agentPersona' ? personaList.loading
                : field.key === 'agentPreset' ? presetList.loading : sessionList.loading) === true ? '读取…' : '刷新'),
          )
        : h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('input', {
        id: field.id,
        type: field.kind === 'number' ? 'number' : 'text',
        value: draft[field.key] ?? '',
        spellCheck: false,
        placeholder: field.placeholder,
        min: field.min,
        max: field.max,
        step: field.step,
        disabled: !writable || busy,
        style: field.kind === 'number'
          ? { ...inputStyle, flex: '0 0 auto', width: field.width ?? 80, boxSizing: 'border-box' }
          : field.capture === true
            ? { ...inputStyle, flex: '0 0 auto', width: field.width ?? 220, boxSizing: 'border-box', fontFamily: 'ui-monospace, monospace' }
            : inputStyle,
        onChange: (event) => {
          setDraft((previous) => ({ ...previous, [field.key]: event.target.value }));
          setMessage(null);
        },
        onKeyDown: (event) => { if (event.key === 'Enter') save(); },
          }),
          field.capture === true
            ? h('button', {
                type: 'button',
                disabled: !writable || busy,
                onClick: () => setCapturing(capturing === field.key ? null : field.key),
                style: capturing === field.key
                  ? { ...buttonStyle, padding: '6px 12px', fontSize: 12, background: 'var(--dsw-alias-state-warn-primary)' }
                  : { ...buttonStyle, padding: '6px 12px', fontSize: 12 },
              }, capturing === field.key ? '请按键…（Esc 取消）' : '录制按键')
            : null,
        ),
      h('p', { style: hintStyle }, field.hint),
    )),
    problem === null ? null : h('p', { style: { ...hintStyle, color: 'var(--dsw-alias-state-warn-primary)' } }, problem),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('button', {
        type: 'button',
        disabled: !canSave,
        style: canSave ? buttonStyle : buttonDisabledStyle,
        onClick: save,
      }, busy ? '保存中…' : '保存'),
      message === null ? null : h('span', { style: { ...hintStyle, color: messageColor } }, message.text),
    ),
    h(GlossaryBox, null),
    h('p', { style: { ...hintStyle, paddingTop: 4 } }, '外部依赖（模型 / venv / 脚本）的检查在「设置 → 插件 → chatterbox 依赖」那一页。'),
  );
}


// ---------------------------------------------------------------- 替换词表

const chipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 8px',
  borderRadius: 999,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
};

/** 语音识别纠错词表：输入中文（空格/回车分隔），拼音由语音端自动生成。 */
function GlossaryBox() {
  const [terms, setTerms] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState(null);

  const apply = (body) => {
    setTerms(Array.isArray(body && body.terms) ? body.terms : []);
    setLoading(false);
  };

  React.useEffect(() => {
    let cancelled = false;
    fetch(INGEST + '/voice/glossary', { cache: 'no-store' })
      .then((response) => response.json())
      .then((body) => { if (!cancelled) apply(body); })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const call = async (method, payload) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(INGEST + '/voice/glossary', {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true) {
        throw new Error((body && body.error && body.error.message) || ('HTTP ' + response.status));
      }
      apply(body);
      return body;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (draft.trim() === '' || busy) return;
    try {
      const body = await call('POST', { text: draft });
      setDraft('');
      const added = body.added || [];
      const updated = body.updated || [];
      const skipped = body.skipped || [];
      const rejected = body.rejected || [];
      const parts = [];
      if (added.length > 0) parts.push('已添加 ' + added.length + ' 个词');
      if (updated.length > 0) parts.push('已更新 ' + updated.length + ' 个（拼音改了）');
      if (skipped.length > 0) parts.push(skipped.length + ' 个重复已跳过');
      if (rejected.length > 0) parts.push('拒绝 ' + rejected.length + ' 个：' + rejected.map((item) => item.text + '（' + item.reason + '）').join('、'));
      setMessage({
        kind: rejected.length > 0 && added.length === 0 && updated.length === 0 ? 'err' : 'ok',
        text: parts.length === 0 ? '没有可添加的词。' : parts.join('；'),
      });
    } catch (error) {
      setMessage({ kind: 'err', text: '添加失败：' + String((error && error.message) || error) });
    }
  };

  const remove = async (text) => {
    if (busy) return;
    try {
      await call('DELETE', { terms: [text] });
      setMessage({ kind: 'ok', text: '已删除「' + text + '」' });
    } catch (error) {
      setMessage({ kind: 'err', text: '删除失败：' + String((error && error.message) || error) });
    }
  };

  const messageColor = message === null
    ? undefined
    : message.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)';

  // Only the newest 10 are rendered: a long list must not bloat the page.
  const recent = terms.slice(-10).reverse();
  const hidden = Math.max(0, terms.length - recent.length);

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
    h('label', { style: labelStyle, htmlFor: 'chatterbox-glossary' }, '替换词表（语音识别纠错）'),
    h('p', { style: hintStyle }, '输入容易听错的专有名词，空格或回车分隔（如「钉宫病 灼眼的夏娜」）。拼音默认自动生成；想钉死读音就写「钉宫病=dinggongbing」（声调可加可不加）。加完下一句生效——之后识别成同音字会被自动改回这些词。'),
    h('textarea', {
      id: 'chatterbox-glossary',
      rows: 4,
      spellCheck: false,
      value: draft,
      placeholder: '钉宫病 灼眼的夏娜=zhuoyandexiana',
      disabled: busy,
      style: { ...inputStyle, minHeight: 76, resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' },
      onChange: (event) => { setDraft(event.target.value); setMessage(null); },
    }),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('button', {
        type: 'button',
        disabled: busy || draft.trim() === '',
        style: busy || draft.trim() === '' ? buttonDisabledStyle : buttonStyle,
        onClick: add,
      }, busy ? '添加中…' : '添加到词表'),
      message === null ? null : h('span', { style: { ...hintStyle, color: messageColor } }, message.text),
    ),
    h('p', { style: hintStyle }, loading
      ? '正在读取词表…'
      : terms.length === 0
        ? '词表还是空的。'
        : hidden > 0
          ? '当前词表 ' + terms.length + ' 个（只显示最近添加的 10 个）：'
          : '当前词表 ' + terms.length + ' 个：'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
      recent.map((item) => h('span', { key: item.text, style: chipStyle },
        item.text + (Array.isArray(item.pinyin) && item.pinyin.length > 0 ? '=' + item.pinyin.join('') : ''),
        h('button', {
          type: 'button',
          title: '从词表删除',
          disabled: busy,
          onClick: () => remove(item.text),
          style: { border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1 },
        }, '×'),
      )),
    ),
  );
}

// ---------------------------------------------------------------- 依赖检查页

const depStatusStyle = (entry) => ({
  flex: '0 0 auto',
  fontWeight: 600,
  color: entry.exists
    ? 'var(--dsw-alias-state-success-primary)'
    : entry.optional === true ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-error-primary)',
});

const PATH_FIELDS = [
  { key: 'asrPython', label: '识别用 Python', placeholder: '留空 = %LOCALAPPDATA%\\dsh\\dsh-chatterbox\\venv\\Scripts\\pythonw.exe' },
  { key: 'asrModelDir', label: 'ASR 模型目录', placeholder: '留空 = ~\\.dsh\\speech-to-text\\sensevoice\\models' },
  { key: 'ttsIrodori', label: 'Irodori 源码目录', placeholder: '留空 = <插件>\\..\\irodori\\Irodori-TTS-main' },
  { key: 'ttsPython', label: '合成用 Python', placeholder: '留空 = <Irodori>\\.venv\\Scripts\\python.exe' },
  { key: 'hfHome', label: 'HF 缓存目录', placeholder: '留空 = <插件>\\..\\cache\\hf-cache' },
];

/** Settings → Plugins → 「chatterbox 依赖」：顶部检测按钮 + 路径填写 + 结果表。 */
function DependencyPage() {
  const [state, setState] = React.useState({ running: false, checked: false, data: null, error: null });
  const [paths, setPaths] = React.useState({ loading: true, values: {}, resolved: {}, error: null });
  const [draft, setDraft] = React.useState({});
  const [saving, setSaving] = React.useState(false);
  const [pathMessage, setPathMessage] = React.useState(null);
  const [install, setInstall] = React.useState({ running: false, root: '', current: '', label: '', received: 0, total: 0, done: [], failed: [], error: '', manifest: null });

  const refreshInstall = () => fetch(INGEST + '/voice/deps/install', { cache: 'no-store' })
    .then((response) => response.json())
    .then((body) => { if (body && body.ok === true) setInstall(body) })
    .catch(() => {});

  React.useEffect(() => {
    refreshInstall();
    const timer = setInterval(() => {
      setInstall((previous) => {
        if (previous.running) refreshInstall();
        return previous;
      });
    }, 800);
    return () => clearInterval(timer);
  }, []);

  const startInstall = async () => {
    try {
      const response = await fetch(INGEST + '/voice/deps/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await response.json();
      if (!body || body.ok !== true) throw new Error((body && body.error && body.error.message) || ('HTTP ' + response.status));
      setInstall((previous) => ({ ...previous, running: true, error: '', done: [], failed: [] }));
      setTimeout(refreshInstall, 300);
    } catch (error) {
      setInstall((previous) => ({ ...previous, error: String((error && error.message) || error) }));
    }
  };

  React.useEffect(() => {
    fetch(INGEST + '/voice/paths', { cache: 'no-store' })
      .then((response) => response.json())
      .then((body) => {
        if (!body || body.ok !== true) throw new Error('Host 返回了异常结果');
        setPaths({ loading: false, values: body.values ?? {}, resolved: body.resolved ?? {}, error: null });
        setDraft(body.values ?? {});
      })
      .catch((error) => setPaths({ loading: false, values: {}, resolved: {}, error: String((error && error.message) || error) }));
  }, []);

  const detect = () => {
    setState((previous) => ({ ...previous, running: true, error: null }));
    fetch(INGEST + '/voice/deps', { cache: 'no-store' })
      .then((response) => response.json())
      .then((body) => {
        if (!body || body.ok !== true) throw new Error('Host 返回了异常结果');
        setState({ running: false, checked: true, data: body, error: null });
      })
      .catch((error) => setState((previous) => ({
        running: false, checked: previous.checked, data: previous.data,
        error: String((error && error.message) || error),
      })));
  };

  const savePaths = async () => {
    setSaving(true);
    setPathMessage(null);
    try {
      const response = await fetch(INGEST + '/voice/paths', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const body = await response.json();
      if (!body || body.ok !== true) throw new Error((body && body.error && body.error.message) || ('HTTP ' + response.status));
      setPaths((previous) => ({ ...previous, values: body.values ?? previous.values }));
      setDraft(body.values ?? {});
      setPathMessage({ kind: 'ok', text: '已保存，开始检测…' });
      detect();
    } catch (error) {
      setPathMessage({ kind: 'err', text: '保存失败：' + String((error && error.message) || error) });
    } finally {
      setSaving(false);
    }
  };

  const wasRunning = React.useRef(false);
  React.useEffect(() => {
    if (wasRunning.current && !install.running) {
      detect();
      refreshInstall();
    }
    wasRunning.current = install.running;
  }, [install.running]);

  const items = state.data && Array.isArray(state.data.items) ? state.data.items : [];
  const bad = items.filter((entry) => entry.ok !== true && entry.optional !== true);
  const pathMessageColor = pathMessage === null
    ? undefined
    : pathMessage.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)';

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 16px' } },
    // ---- 置顶：检测按钮 + 结论 ----
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
      h('button', {
        type: 'button',
        disabled: state.running,
        onClick: detect,
        style: state.running ? buttonDisabledStyle : buttonStyle,
      }, state.running ? '检测中…' : (state.checked ? '重新检测' : '开始检测')),
      state.data === null ? null : h('span', {
        style: {
          ...hintStyle,
          fontWeight: 600,
          color: bad.length === 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
        },
      }, bad.length === 0 ? '全部就绪' : ('有 ' + bad.length + ' 项异常')),
      state.data === null ? null : h('span', { style: hintStyle },
        '检测于 ' + String(state.data.checkedAt || '').replace('T', ' ').slice(0, 19) + ' · 插件 ' + (state.data.version || '')),
    ),
    h('p', { style: hintStyle },
      '检测只在点按钮时执行（含 python import 抽查与模型体积校验，约需几秒）。下面可以先填外部依赖的路径：留空就用默认值，填了就优先用你填的。完整清单与手动安装命令见 docs\\DEPENDENCIES.zh.md。'),
    state.error === null ? null : h('p', { style: { ...hintStyle, color: 'var(--dsw-alias-state-error-primary)' } }, '检测失败：' + state.error),

    // ---- 下载并安装缺失项 ----
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('button', {
          type: 'button',
          disabled: install.running,
          onClick: startInstall,
          style: install.running ? buttonDisabledStyle : buttonStyle,
        }, install.running ? '安装中…' : '下载并安装缺失'),
        h('span', { style: hintStyle },
          '下载到 ' + (install.root || '<插件>\\deps') + '（ASR 模型约 155 MB + VAD 1.8 MB + Irodori 源码，约 165 MB；已存在的项会自动跳过）'),
      ),
      install.running
        ? h('div', { style: hintStyle },
            (install.label || install.current || '准备中') + ' — '
            + (install.received / 1048576).toFixed(1) + ' MB'
            + (install.total > 0 ? ' / ' + (install.total / 1048576).toFixed(1) + ' MB' : ''))
        : null,
      install.done.length > 0
        ? h('div', { style: { ...hintStyle, color: 'var(--dsw-alias-state-success-primary)' } }, '已装好：' + install.done.join('、'))
        : null,
      install.failed.length > 0
        ? h('div', { style: { ...hintStyle, color: 'var(--dsw-alias-state-error-primary)' } }, '失败：' + install.failed.join('、') + (install.error ? '（' + install.error + '）' : ''))
        : null,
    ),

    // ---- 外部依赖路径 ----
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l1)', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
      h('span', { style: labelStyle }, '外部依赖路径'),
      paths.error === null ? null : h('p', { style: { ...hintStyle, color: 'var(--dsw-alias-state-error-primary)' } }, '读取路径失败：' + paths.error),
      ...PATH_FIELDS.map((field) => h('div', { key: field.key, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        h('label', { style: { ...hintStyle, fontWeight: 600 }, htmlFor: 'chatterbox-path-' + field.key }, field.label),
        h('input', {
          id: 'chatterbox-path-' + field.key,
          type: 'text',
          spellCheck: false,
          value: draft[field.key] ?? '',
          placeholder: field.placeholder,
          disabled: saving || paths.loading,
          style: inputStyle,
          onChange: (event) => {
            setDraft((previous) => ({ ...previous, [field.key]: event.target.value }));
            setPathMessage(null);
          },
        }),
        (paths.resolved && paths.resolved[field.key])
          ? h('span', { style: hintStyle },
              '当前生效：' + paths.resolved[field.key].value + '（来源：' + paths.resolved[field.key].source + '）')
          : null,
      )),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('button', {
          type: 'button',
          disabled: saving || paths.loading,
          onClick: savePaths,
          style: saving || paths.loading ? buttonDisabledStyle : buttonStyle,
        }, saving ? '保存中…' : '保存路径并检测'),
        pathMessage === null ? null : h('span', { style: { ...hintStyle, color: pathMessageColor } }, pathMessage.text),
      ),
    ),

    // ---- 检测结果 ----
    state.checked ? null : h('p', { style: hintStyle }, '尚未检测。'),
    ...items.map((entry) => h('div', {
      key: entry.id,
      style: {
        display: 'flex', flexDirection: 'column', gap: 2,
        padding: '6px 8px', borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: entry.ok === true || entry.optional === true ? 'transparent' : 'var(--dsw-alias-bg-layer-1)',
      },
    },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
        h('span', { style: labelStyle }, entry.label),
        h('span', {
          style: {
            flex: '0 0 auto',
            fontWeight: 600,
            color: entry.ok === true
              ? 'var(--dsw-alias-state-success-primary)'
              : entry.optional === true ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-error-primary)',
          },
        }, entry.ok === true ? '✓' : (entry.optional === true ? '—' : '✗')),
        h('span', { style: { ...hintStyle, marginLeft: 'auto' } }, entry.size + ' · ' + entry.source),
      ),
      h('div', { style: { ...hintStyle, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' } }, entry.path),
      entry.integrity && entry.integrity.detail ? h('div', { style: hintStyle }, entry.integrity.detail) : null,
      entry.files > 0 ? h('div', { style: hintStyle }, entry.files + ' 个文件' + (entry.truncated ? '（统计已截断）' : '')) : null,
      entry.ok === true ? null : h('div', { style: { ...hintStyle, color: 'var(--dsw-alias-state-warn-primary)' } }, entry.hint),
    )),
  );
}

// ---------------------------------------------------------------- 自由麦克风

const micIcon = h('svg', {
  width: 13,
  height: 13,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.1,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
},
  h('rect', { x: 9, y: 2.5, width: 6, height: 11, rx: 3 }),
  h('path', { d: 'M5.5 11a6.5 6.5 0 0 0 13 0' }),
  h('path', { d: 'M12 17.5V21' }),
  h('path', { d: 'M8.5 21h7' }),
);

// off = gray; live = green, low-frequency pulse; wait = dim green (paused for
// the current turn). Kept in one stylesheet so the animation costs no re-render.
const DOT_STYLE = [
  '.chatterbox-mic-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;transition:background 120ms ease}',
  '.chatterbox-mic-dot[data-state="off"]{background:var(--dsw-alias-state-idle-primary)}',
  '.chatterbox-mic-dot[data-state="live"]{background:var(--dsw-alias-state-success-primary);animation:chatterbox-mic-pulse 1.6s steps(1,end) infinite}',
  '.chatterbox-mic-dot[data-state="wait"]{background:var(--dsw-alias-state-success-primary);opacity:.4}',
  '@keyframes chatterbox-mic-pulse{0%{background-color:var(--dsw-alias-state-success-primary)}50%,100%{background-color:#0d4f2c;background-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,#000)}}',
  '@media (prefers-reduced-motion: reduce){.chatterbox-mic-dot[data-state="live"]{animation:none}}',
].join('');

/** The master switch: gray dot + mic + 自由麦克风; green while listening. */
function FreeMicButton() {
  const [snapshot, setSnapshot] = React.useState(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState(null);
  const alive = React.useRef(true);

  React.useEffect(() => {
    alive.current = true;
    let timer = null;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`${INGEST}/voice/state`, { cache: 'no-store' });
        const body = await response.json();
        if (!cancelled && alive.current) {
          setSnapshot(body);
          setError(null);
        }
      } catch (failure) {
        if (!cancelled && alive.current) {
          setSnapshot(null);
          setError(String(failure && failure.message ? failure.message : failure));
        }
      }
      if (!cancelled && alive.current) timer = setTimeout(poll, 250);
    };
    poll();
    return () => {
      cancelled = true;
      alive.current = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  const enabled = snapshot !== null && snapshot.enabled === true;
  const paused = enabled && snapshot.paused === true;
  const available = snapshot !== null;

  const toggle = () => {
    if (pending) return;
    const next = !enabled;
    setPending(true);
    setSnapshot(snapshot === null ? null : { ...snapshot, enabled: next, paused: false });
    fetch(`${INGEST}/voice/free-mic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    })
      .then((response) => response.json())
      .then((body) => { if (alive.current) { setSnapshot(body); setError(null); } })
      .catch((failure) => {
        if (alive.current) setError(String(failure && failure.message ? failure.message : failure));
      })
      .finally(() => { if (alive.current) setPending(false); });
  };

  const dotState = !enabled ? 'off' : (paused ? 'wait' : 'live');
  const silenceLabel = snapshot !== null && typeof snapshot.vadSilence === 'number' ? snapshot.vadSilence : 2;
  const idleMinutes = snapshot !== null && typeof snapshot.idleTimeoutMs === 'number'
    ? Math.max(1, Math.round(snapshot.idleTimeoutMs / 60_000))
    : null;
  const autoOffNote = idleMinutes === null ? '' : `；${idleMinutes} 分钟没有任何收音会自动关`;
  // The voice client reports its capture state; a mismatch means the switch is
  // on but nothing is actually being recorded, which is worth saying out loud.
  const clientWarning = enabled && !paused && snapshot.clientListening === false
    ? '（语音端还没开始收音）'
    : '';
  const title = !available
    ? `自由麦克风：连不上 dsh-chatterbox 端口 ${INGEST}${error === null ? '' : '（' + error + '）'}`
    : !enabled
      ? `自由麦克风：关。点一下开启持续收音（替代按住说话）${autoOffNote}`
      : paused
        ? `自由麦克风：开。正在等这一轮回复说完，暂时不听${autoOffNote}`
        : `自由麦克风：开。静默 ${silenceLabel} 秒即投送${clientWarning}${autoOffNote}`;

  const style = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 24,
    padding: '0 8px',
    borderRadius: 6,
    border: '1px solid transparent',
    background: enabled ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
    color: enabled ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
    font: 'inherit',
    fontSize: 12,
    lineHeight: 1,
    cursor: available && !pending ? 'pointer' : 'default',
    opacity: available ? 1 : 0.55,
    userSelect: 'none',
  };

  return h(hFragment, null,
    h('style', { key: 'chatterbox-free-mic-style' }, DOT_STYLE),
    h('button', {
      type: 'button',
      'data-free-mic': enabled ? 'on' : 'off',
      'data-free-mic-paused': paused ? 'true' : undefined,
      'data-free-mic-dot': dotState,
      'aria-pressed': enabled,
      title,
      disabled: !available || pending,
      style,
      onClick: toggle,
    },
      h('span', { className: 'chatterbox-mic-dot', 'data-state': dotState }),
      micIcon,
      h('span', null, '自由麦克风'),
    ),
  );
}


// ---------------------------------------------------------------- 重放拦截

const REPLAY_PREFIX = INGEST + '/voice/play?name=';
/** Same-name clicks inside this window are treated as one (a click can arrive
 *  twice: pointer + click, or two bundles installed). */
const REPLAY_DEBOUNCE_MS = 600;

/** One short-lived toast: replay is a click, not a page. */
function showReplayToast(text) {
  try {
    const box = document.createElement('div');
    box.textContent = text;
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;'
      + 'padding:8px 12px;border-radius:8px;background:rgba(17,17,17,.92);color:#eee;'
      + 'font:13px system-ui;box-shadow:0 6px 20px rgba(0,0,0,.35);pointer-events:none';
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 1800);
  } catch (error) {
    // A toast must never break the click.
  }
}

/** True when the click landed on one of our ▶ 重放 links. */
function replayHrefOf(event) {
  const target = event.target;
  const anchor = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
  if (anchor === null || anchor === undefined) return null;
  const href = anchor.getAttribute('href') ?? '';
  return href.startsWith(REPLAY_PREFIX) ? href : null;
}

/**
 * The chat renders ▶ 重放 as a normal markdown link, and DSH opens those in its
 * side panel. Capture the click first: prevent the panel, POST to the Host and
 * play in place.
 */
function installReplayInterceptor(ctx) {
  if (typeof document === 'undefined') return undefined;
  // The client bundle can be applied more than once (page refresh, plugin
  // reload, HMR). Keep exactly one listener on the document.
  const previous = document.__dshChatterboxReplayDispose;
  if (typeof previous === 'function') previous();
  const onMouseDown = (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (replayHrefOf(event) === null) return;
    // Some shells open the panel on mousedown; stopping it here leaves the
    // click event intact for the handler below.
    event.preventDefault();
  };
  const onClick = (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const href = replayHrefOf(event);
    if (href === null) return;
    event.preventDefault();
    event.stopPropagation();
    // Plain string parsing: no URL constructor needed in every host shell.
    const match = /[?&]name=([^&]+)/.exec(href);
    let name = '';
    try {
      name = match === null ? '' : decodeURIComponent(match[1]);
    } catch (error) {
      name = match[1];
    }
    if (name === '') {
      showReplayToast('重放失败：缺少文件名');
      return;
    }
    const now = Date.now();
    const last = document.__dshChatterboxLastReplay || { name: '', at: 0 };
    if (name === last.name && now - last.at < REPLAY_DEBOUNCE_MS) return;
    document.__dshChatterboxLastReplay = { name, at: now };
    fetch(INGEST + '/voice/replay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then((response) => response.json())
      .then((body) => {
        if (!body || body.ok !== true) {
          throw new Error((body && body.error && body.error.message) || 'Host 拒绝了重放');
        }
        showReplayToast('▶ 正在重放…');
      })
      .catch((error) => showReplayToast('重放失败：' + String((error && error.message) || error)));
  };
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('click', onClick, true);
  const dispose = () => {
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('click', onClick, true);
    if (document.__dshChatterboxReplayDispose === dispose) document.__dshChatterboxReplayDispose = undefined;
  };
  document.__dshChatterboxReplayDispose = dispose;
  if (ctx && typeof ctx.on === 'function') ctx.on('dispose', dispose);
  return dispose;
}

/** Mount both contributions. */
function apply(ctx) {
  ctx.slots.inject('plugins.row.config', function* () {
    yield ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-chatterbox#chatterbox' }, SettingsForm);
  });
  // Right after the Computer Use control, which occupies order 24 in this slot.
  ctx.slots.inject('conversation.input.left', function* () {
    yield ctx.slots.register({ name: 'conversation.input.left', id: 'dsh-chatterbox-free-mic', order: 25 }, FreeMicButton);
  });

  // Second settings page: Settings → Plugins → 「chatterbox 依赖」.
  ctx.slots.inject('settings.plugins.tab', function* () {
    yield ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'dsh-chatterbox-deps',
      order: 50,
      label: 'chatterbox 依赖',
    }, DependencyPage);
  });
  installReplayInterceptor(ctx);
}
}}};
const cache=Object.create(null);
function load(id){if(cache[id])return cache[id].exports;const entry=modules[id];if(!entry)throw new Error("Unknown dsh-chatterbox browser module: "+id);const module={exports:{}};cache[id]=module;entry.run(module,module.exports,request=>Object.hasOwn(entry.imports,request)?load(entry.imports[request]):require(request));return module.exports;}
return load("client/index.js");
}});
