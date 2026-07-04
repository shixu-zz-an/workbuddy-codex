export function dashboardHtml(config) {
  const mode = config.mode || "app-server";
  const tokenProxy = config.tokenProxy || {};
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WorkBuddy Codex Gateway</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 980px; margin: 0 auto; padding: 32px 20px 56px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin: 26px 0 10px; font-size: 18px; }
    p { line-height: 1.6; color: color-mix(in srgb, CanvasText 72%, transparent); }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
    .panel { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; padding: 16px; background: color-mix(in srgb, Canvas 94%, CanvasText 6%); }
    label { display: block; margin: 10px 0 6px; font-weight: 600; }
    input, select { width: 100%; box-sizing: border-box; padding: 9px 10px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); background: Canvas; color: CanvasText; }
    input[type="checkbox"], input[type="radio"] { width: auto; }
    .row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    button { border: 0; border-radius: 6px; padding: 10px 14px; background: #166534; color: white; cursor: pointer; font-weight: 700; }
    button.secondary { background: #334155; }
    button.warn { background: #991b1b; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    pre { overflow: auto; padding: 12px; border-radius: 8px; background: color-mix(in srgb, CanvasText 10%, Canvas); }
    .muted { color: color-mix(in srgb, CanvasText 58%, transparent); }
    .danger { color: #b91c1c; font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <h1>WorkBuddy Codex Gateway</h1>
    <p>把 WorkBuddy 的自定义模型请求转到本机 Codex。默认使用 Codex app-server 长驻桥接；紧急模式可转发到自定义 token proxy endpoint。</p>

    <div class="grid">
      <section class="panel">
        <h2>运行模式</h2>
        <div class="row"><input id="mode-app" type="radio" name="mode" value="app-server" ${mode === "app-server" ? "checked" : ""} /><label for="mode-app">正常：Codex app-server bridge</label></div>
        <p class="muted">长驻 Codex app-server，支持 thread、turn、工具调用回填，适合作为主模式。</p>
        <div class="row"><input id="mode-token" type="radio" name="mode" value="token-proxy" ${mode === "token-proxy" ? "checked" : ""} /><label for="mode-token">紧急：Token proxy</label></div>
        <p class="muted">直接转发请求到你配置的 endpoint。该模式只在明确确认风险后启用。</p>
        <button onclick="saveMode()">保存模式</button>
      </section>

      <section class="panel">
        <h2>WorkBuddy 配置</h2>
        <p>Endpoint:</p>
        <pre>http://${config.server.host}:${config.server.port}/v1/chat/completions</pre>
        <p>模型 ID:</p>
        <pre>codex-app-server
codex-token-proxy</pre>
        <button class="secondary" onclick="installWorkBuddy()">写入 ~/.workbuddy/models.json</button>
      </section>
    </div>

    <section class="panel">
      <h2>Codex 正常模式</h2>
      <label>Working directory</label>
      <input id="codex-cwd" value="${escapeHtml(config.codex?.cwd || "")}" />
      <label>Model override</label>
      <input id="codex-model" value="${escapeHtml(config.codex?.model || "")}" placeholder="留空使用 Codex 默认模型" />
      <label>Reasoning effort</label>
      <select id="codex-effort">
        ${["low", "medium", "high", "xhigh", "ultra"].map((item) => `<option value="${item}" ${config.codex?.effort === item ? "selected" : ""}>${item}</option>`).join("")}
      </select>
      <label>Sandbox</label>
      <select id="codex-sandbox">
        ${["read-only", "workspace-write", "danger-full-access"].map((item) => `<option value="${item}" ${config.codex?.sandbox === item ? "selected" : ""}>${item}</option>`).join("")}
      </select>
      <button onclick="saveCodex()">保存 Codex 设置</button>
    </section>

    <section class="panel">
      <h2>紧急 Token Proxy</h2>
      <p class="danger">高风险模式：只建议在 app-server bridge 不可用时临时使用。不要把私有 token 提交到仓库或日志。</p>
      <label>Endpoint</label>
      <input id="token-endpoint" value="${escapeHtml(tokenProxy.endpoint || "")}" />
      <label>Model override</label>
      <input id="token-model" value="${escapeHtml(tokenProxy.model || "")}" placeholder="留空则使用 WorkBuddy 请求里的 model" />
      <label>Bearer token env</label>
      <input id="token-env" value="${escapeHtml(tokenProxy.bearerTokenEnv || "WORKBUDDY_CODEX_BEARER_TOKEN")}" />
      <div class="row"><input id="token-enabled" type="checkbox" ${tokenProxy.enabled ? "checked" : ""} /><label for="token-enabled">启用 token proxy</label></div>
      <div class="row"><input id="token-risk" type="checkbox" ${tokenProxy.riskAccepted ? "checked" : ""} /><label for="token-risk">我理解该模式可能有账号、合规和稳定性风险</label></div>
      <button class="warn" onclick="saveTokenProxy()">保存紧急模式配置</button>
    </section>

    <section class="panel">
      <h2>状态</h2>
      <button class="secondary" onclick="refreshStatus()">刷新状态</button>
      <button onclick="testGateway()">测试请求</button>
      <pre id="status">加载中...</pre>
    </section>
  </main>
  <script>
    async function api(path, options) {
      const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
      const body = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(body, null, 2));
      return body;
    }
    async function refreshStatus() {
      document.querySelector('#status').textContent = JSON.stringify(await api('/api/status'), null, 2);
    }
    async function saveMode() {
      const mode = document.querySelector('input[name="mode"]:checked').value;
      await api('/api/config', { method: 'POST', body: JSON.stringify({ mode }) });
      await refreshStatus();
    }
    async function saveTokenProxy() {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ tokenProxy: {
        endpoint: document.querySelector('#token-endpoint').value,
        model: document.querySelector('#token-model').value,
        bearerTokenEnv: document.querySelector('#token-env').value,
        enabled: document.querySelector('#token-enabled').checked,
        riskAccepted: document.querySelector('#token-risk').checked
      }}) });
      await refreshStatus();
    }
    async function saveCodex() {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ codex: {
        cwd: document.querySelector('#codex-cwd').value,
        model: document.querySelector('#codex-model').value,
        effort: document.querySelector('#codex-effort').value,
        sandbox: document.querySelector('#codex-sandbox').value
      }}) });
      await refreshStatus();
    }
    async function installWorkBuddy() {
      document.querySelector('#status').textContent = JSON.stringify(await api('/api/install-workbuddy', { method: 'POST', body: '{}' }), null, 2);
    }
    async function testGateway() {
      const output = document.querySelector('#status');
      output.textContent = '';
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'codex-app-server', stream: true, messages: [{ role: 'user', content: '请只回复 OK' }] })
      });
      if (!res.ok || !res.body) {
        output.textContent = await res.text();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        output.textContent += decoder.decode(value, { stream: true });
      }
      output.textContent += decoder.decode();
    }
    refreshStatus().catch(error => { document.querySelector('#status').textContent = error.message; });
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
