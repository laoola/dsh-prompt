/**
 * dsh-prompt client half — 提示词选择器(decoration 型 web client 插件,plain JS 零依赖)
 *
 * 机制依据(Spike 结论,均出自 DSH 安装版类型声明):
 * - 加载:window.__ModuleLoader__.load({ id: 包名, factory(require) }),React 取自浏览器模块表。
 *   参照 templates/decoration/client.js 与 @deepseek-ai/dsh-client-ui-skill/lib/client.js。
 * - 注册:ctx.slots.inject('conversation.input.left', fn) 声明占用,fn 内
 *   ctx.slots.register({name, id, order}, Component)。
 *   conversation.input.left = composer 工具行左侧紧凑控件座
 *   (@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:230-233,list+session scope)。
 * - 组件标准 props(session scope 自动获得):
 *   · sessionId(@deepseek-ai/dsh-client-ui-session/lib/types/client/index.d.ts:81)
 *   · useSession: SessionSnapshotSelector(同上 :79,可判 openState/removed 做置灰降级)
 *   · inputActions: InputActions(conversation slots.d.ts:332-339 merge;契约 input.d.ts:206-226)
 *     setDraft(text) 整体替换草稿,不自动发送(input.d.ts:222)。
 * - 数据通道:ctx.remote.commands.execute(sid, '/prompt … --json')
 *   (@deepseek-ai/dsh-api-remotes 生成面;ui-skill/lib/client.js 同构用法)。
 *   返回 {ok:true,value}|{ok:false,error};value.result = {kind:'success',text}|{kind:'error',text}。
 *   host 契约(冻结):list --json → JSON 数组 [{name,description,tags,source,updated,malformed}];
 *   show <名> --json → 对象 {name,description,tags,source,updated,body};error.text 为人读文案。
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** apply() 时注入的 remote.commands 服务面;组件通过 runCommand 使用。 */
    let commandFace = null;

    /**
     * 执行一条 /prompt 命令并解开两层信封(RPC 层 + 命令层),返回解析后的 JSON。
     * @param {string} sid sessionId(标准座 props 提供)
     * @param {string} line 完整命令行,如 '/prompt list --json'
     */
    async function runCommand(sid, line) {
      if (!commandFace) throw new Error('插件服务未就绪(remote.commands 不可用)');
      // 实测签名（dsh-commands/lib/typert.remote-client.d.ts:11）：execute(agentId, line, submittedAttachments, signal?)，
      // 第三参必填（api-gateway 按参数表长度校验，缺它报 expected 3 business argument(s) got 2）；选择器无附件传 []。
      const res = await commandFace.execute(sid, line, []);
      if (!res || res.ok === false) {
        const msg = res && res.error && res.error.message ? res.error.message : 'RPC 调用失败';
        throw new Error(msg);
      }
      const cmd = res.value && res.value.result;
      if (!cmd || cmd.kind !== 'success') {
        throw new Error((cmd && cmd.text) || '命令执行失败');
      }
      return JSON.parse(cmd.text);
    }

    const STYLE_ID = 'dsh-prompt-picker-style';

    const S = {
      wrap: { position: 'relative', display: 'inline-flex' },
      btn: {
        appearance: 'none', border: 'none', background: 'transparent', color: 'inherit',
        font: 'inherit', fontSize: '12px', lineHeight: '1.2', padding: '4px 8px',
        borderRadius: '6px', cursor: 'pointer', display: 'inline-flex',
        alignItems: 'center', whiteSpace: 'nowrap',
      },
      btnActive: { background: 'rgba(127,127,127,0.18)' },
      btnDisabled: { opacity: 0.45, cursor: 'default' },
      panel: {
        position: 'fixed', zIndex: 9999, width: '380px', maxHeight: '420px',
        display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
        background: '#ffffff', color: '#1f2328',
        border: '1px solid rgba(0,0,0,0.15)', borderRadius: '10px',
        boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
        fontFamily: 'inherit', fontSize: '13px', overflow: 'hidden',
      },
      header: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px 6px' },
      title: { fontWeight: 600, fontSize: '13px' },
      spacer: { flex: 1 },
      miniBtn: {
        appearance: 'none', border: 'none', background: 'transparent', color: '#57606a',
        font: 'inherit', fontSize: '12px', padding: '3px 6px', borderRadius: '6px',
        cursor: 'pointer',
      },
      filter: {
        margin: '0 12px 8px', padding: '6px 8px', fontSize: '13px', boxSizing: 'border-box',
        border: '1px solid rgba(0,0,0,0.18)', borderRadius: '6px', outline: 'none',
        width: 'calc(100% - 24px)', background: 'transparent', color: 'inherit',
      },
      list: { overflowY: 'auto', padding: '0 6px 8px', margin: 0, listStyle: 'none' },
      item: { padding: '7px 8px', borderRadius: '8px' },
      name: { fontWeight: 600 },
      desc: {
        color: '#57606a', marginTop: '2px', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      tags: { color: '#0969da', fontSize: '11px', marginTop: '2px' },
      tagGap: { marginRight: '6px' },
      empty: { padding: '18px 14px', color: '#57606a', textAlign: 'center', lineHeight: 1.6 },
      error: { padding: '4px 14px 10px', color: '#cf222e', whiteSpace: 'pre-wrap' },
      badge: {
        marginLeft: '6px', fontSize: '10px', color: '#9a6700', background: '#fff8c5',
        border: '1px solid rgba(212,167,44,0.4)', borderRadius: '4px', padding: '0 4px',
      },
      busy: { color: '#57606a', fontSize: '11px', marginLeft: '6px' },
    };

    /**
     * 提示词选择器:composer 工具行左侧紧凑按钮 + 弹出面板。
     * props 为 session-scope slot 标准座(sessionId/useSession)+ conversation merge(inputActions)。
     */
    function PromptPicker(props) {
      const sid = props.sessionId;
      const inputActions = props.inputActions;

      const [open, setOpen] = React.useState(false);
      const [entries, setEntries] = React.useState(null); // null = 加载中
      const [error, setError] = React.useState(null);
      const [filter, setFilter] = React.useState('');
      const [busyName, setBusyName] = React.useState(null);
      const [panelPos, setPanelPos] = React.useState(null);

      const btnRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const filterRef = React.useRef(null);

      // 会话未就绪降级:openState 非 open 或已移除 → 按钮置灰。
      // useSession 由 ui-session 标准座保证(index.d.ts:79),按 hooks 规则无条件调用。
      const sessionReady = props.useSession(
        (s) => !!(s && s.openState === 'open' && !s.removed),
      );

      // 全局样式(条目 hover 态),模块卸载时随 effect 清理。
      React.useEffect(() => {
        if (document.getElementById(STYLE_ID)) return undefined;
        const el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent =
          '.dshp-item:hover{background:rgba(0,0,0,0.06)}' +
          '.dshp-item[data-busy="1"]{opacity:0.6}';
        document.head.appendChild(el);
        return () => {
          const x = document.getElementById(STYLE_ID);
          if (x) x.remove();
        };
      }, []);

      const openPanel = React.useCallback(() => {
        const rect = btnRef.current ? btnRef.current.getBoundingClientRect() : null;
        if (rect) {
          const width = 380;
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
          const bottom = Math.max(8, window.innerHeight - rect.top + 6);
          setPanelPos({ left: left + 'px', bottom: bottom + 'px' });
        }
        setOpen(true);
      }, []);

      const loadList = React.useCallback(async () => {
        setEntries(null);
        setError(null);
        try {
          const data = await runCommand(sid, '/prompt list --json');
          if (!Array.isArray(data)) throw new Error('返回数据格式异常(非数组)');
          setEntries(data);
        } catch (err) {
          setError((err && err.message) || String(err));
        }
      }, [sid]);

      // 打开面板即拉取列表。
      React.useEffect(() => {
        if (open) loadList();
      }, [open, loadList]);

      // Esc / 点外部关闭(捕获阶段,Esc 归面板)。
      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
        };
        const onDown = (e) => {
          const p = panelRef.current;
          const b = btnRef.current;
          if (p && p.contains(e.target)) return;
          if (b && b.contains(e.target)) return;
          setOpen(false);
        };
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('mousedown', onDown, true);
        return () => {
          document.removeEventListener('keydown', onKey, true);
          document.removeEventListener('mousedown', onDown, true);
        };
      }, [open]);

      // 点选:取正文 → setDraft 整体替换草稿(不发送)→ 关面板。
      const pick = React.useCallback(async (entry) => {
        if (busyName) return;
        setBusyName(entry.name);
        try {
          const data = await runCommand(sid, '/prompt show ' + entry.name + ' --json');
          if (!data || typeof data.body !== 'string') throw new Error('提示词正文缺失');
          if (!inputActions || typeof inputActions.setDraft !== 'function') {
            throw new Error('输入框接口不可用(inputActions.setDraft 缺失)');
          }
          inputActions.setDraft(data.body);
          setOpen(false);
        } catch (err) {
          setError((err && err.message) || String(err));
        } finally {
          setBusyName(null);
        }
      }, [sid, inputActions, busyName]);

      const kw = filter.trim().toLowerCase();
      const visible = entries
        ? entries.filter((e) => !kw
          || String(e.name || '').toLowerCase().includes(kw)
          || String(e.description || '').toLowerCase().includes(kw)
          || (Array.isArray(e.tags)
            && e.tags.some((t) => String(t).toLowerCase().includes(kw))))
        : null;

      return h('span', { style: S.wrap },
        h('button', {
          ref: btnRef,
          type: 'button',
          title: '提示词库:点选后填入输入框(不发送)',
          style: Object.assign({}, S.btn,
            open ? S.btnActive : null,
            !sessionReady ? S.btnDisabled : null),
          disabled: !sessionReady,
          onClick: () => { if (open) { setOpen(false); } else { openPanel(); } },
        }, '提示词'),
        open && h('div', { ref: panelRef, style: Object.assign({}, S.panel, panelPos || {}) },
          h('div', { style: S.header },
            h('span', { style: S.title }, '提示词库'),
            h('button', {
              type: 'button', style: S.miniBtn, title: '重新加载',
              onClick: () => { loadList(); },
            }, '刷新'),
            h('span', { style: S.spacer }),
            h('button', {
              type: 'button', style: S.miniBtn, title: '关闭(Esc)',
              onClick: () => { setOpen(false); },
            }, '✕'),
          ),
          h('input', {
            ref: filterRef,
            style: S.filter,
            placeholder: '过滤:名称 / 描述 / 标签',
            value: filter,
            onChange: (e) => setFilter(e.target.value),
          }),
          error ? h('div', { style: S.error }, error) : null,
          !error && entries === null ? h('div', { style: S.empty }, '加载中…') : null,
          !error && entries !== null && visible.length === 0
            ? h('div', { style: S.empty },
              kw ? '没有匹配的提示词'
                : '库为空。用 /prompt add 保存当前草稿,或 /prompt restore 恢复种子提示词。')
            : null,
          !error && entries !== null && visible.length > 0
            ? h('ul', { style: S.list },
              visible.map((entry, i) => h('li', {
                key: entry.name || 'item-' + i,
                className: 'dshp-item',
                'data-busy': busyName === entry.name ? '1' : '0',
                style: Object.assign({}, S.item, {
                  cursor: entry.malformed || busyName ? 'default' : 'pointer',
                  opacity: entry.malformed ? 0.55 : 1,
                }),
                onClick: () => { if (!entry.malformed) pick(entry); },
              },
                h('div', null,
                  h('span', { style: S.name }, entry.name || '(未命名)'),
                  entry.malformed ? h('span', { style: S.badge }, '损坏') : null,
                  busyName === entry.name ? h('span', { style: S.busy }, '读取中…') : null,
                ),
                entry.description ? h('div', { style: S.desc }, entry.description) : null,
                Array.isArray(entry.tags) && entry.tags.length
                  ? h('div', { style: S.tags },
                    entry.tags.map((t, j) => h('span', { key: j, style: S.tagGap }, '#' + t)))
                  : null,
              )))
            : null,
        ),
      );
    }

    return {
      inject: ['slots', 'remote', 'remote.commands'],
      apply(ctx) {
        commandFace = ctx.remote.commands;
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-prompt-picker',
          order: 90,
          label: () => '提示词',
        }, PromptPicker));
      },
    };
  },
});
