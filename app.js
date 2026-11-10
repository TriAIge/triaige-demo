// Fluxo do TriAIge disparado pelo formulário:
// 1. cria a sessão  2. para cada arquivo: presign -> upload S3 -> complete  3. finaliza
// Depois acompanha o status da sessão até chegar num estado final.

const AREAS = {
  TRABALHISTA: ["HORAS_EXTRAS", "RESCISAO_INDIRETA", "VERBAS_RESCISORIAS", "ASSEDIO_MORAL", "ACIDENTE_DE_TRABALHO"],
  CIVEL: ["INDENIZACAO", "COBRANCA", "CONTRATOS", "RESPONSABILIDADE_CIVIL"],
  CONSUMIDOR: ["PRODUTO_DEFEITUOSO", "COBRANCA_INDEVIDA", "NEGATIVACAO_INDEVIDA", "SERVICO_NAO_PRESTADO"],
  FAMILIA: ["DIVORCIO", "PENSAO_ALIMENTICIA", "GUARDA", "INVENTARIO"],
  PREVIDENCIARIO: ["APOSENTADORIA", "AUXILIO_DOENCA", "BPC_LOAS"],
};

const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/tiff"];

const STEPS = ["Documentos recebidos", "Leitura e anonimização", "Análise de IA", "Escritório notificado"];

// status da sessão -> [etapa em andamento, falhou?]. Etapas antes dela aparecem como concluídas.
const STATUS_STEP = {
  RECEIVING_DOCUMENTS: [0, false],
  QUEUED_FOR_PROCESSING: [1, false],
  COMPLETED: [2, false],
  PARTIALLY_COMPLETED: [2, false],
  ANALYZING: [2, false],
  ANALYSIS_COMPLETED: [3, false],
  NOTIFIED: [4, false],
  CANCELLED: [0, true],
  FAILED: [1, true],
  ANALYSIS_FAILED: [2, true],
  NOTIFICATION_FAILED: [3, true],
};
const FINAL = ["NOTIFIED", "CANCELLED", "FAILED", "ANALYSIS_FAILED", "NOTIFICATION_FAILED"];

const $ = (id) => document.getElementById(id);
const form = $("form");
let files = [];
let pollTimer = null;

// ---------- formulário ----------

const pretty = (s) => s.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

$("area").innerHTML = Object.keys(AREAS).map((a) => `<option value="${a}">${pretty(a)}</option>`).join("");
const fillTipos = () => {
  $("tipo").innerHTML = AREAS[$("area").value].map((t) => `<option value="${t}">${pretty(t)}</option>`).join("");
};
$("area").addEventListener("change", fillTipos);
fillTipos();

form.resumo.addEventListener("input", () => ($("count").textContent = form.resumo.value.length));

$("files").addEventListener("change", (e) => addFiles(e.target.files));
["dragover", "dragenter"].forEach((ev) =>
  $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.add("over"); }));
["dragleave", "drop"].forEach((ev) =>
  $("drop").addEventListener(ev, () => $("drop").classList.remove("over")));
$("drop").addEventListener("drop", (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });

function addFiles(list) {
  for (const f of list) {
    if (!ALLOWED_TYPES.includes(contentTypeOf(f))) {
      showError(`"${f.name}" não é um formato aceito (PDF, PNG, JPG ou TIFF).`);
      continue;
    }
    if (!files.some((x) => x.name === f.name && x.size === f.size)) files.push(f);
  }
  $("files").value = "";
  renderFiles();
}

function renderFiles() {
  $("fileList").innerHTML = files
    .map((f, i) => `<li><span>${escapeHtml(f.name)} <small>${formatSize(f.size)}</small></span>
      <button type="button" class="link" data-i="${i}">remover</button></li>`)
    .join("");
  $("fileList").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => { files.splice(Number(b.dataset.i), 1); renderFiles(); }));
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();
  if (!form.checkValidity()) return showError("Preencha os campos obrigatórios e aceite o termo.");
  if (files.length === 0) return showError("Anexe pelo menos um documento.");

  setBusy(true, "Criando atendimento...");
  try {
    const session = await api("POST", "/sessions", {
      caso: {
        titulo: form.resumo.value.trim().slice(0, 255),
        areaJuridica: form.areaJuridica.value,
        tipoCaso: form.tipoCaso.value,
      },
    }, crypto.randomUUID());

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const type = contentTypeOf(f);
      setBusy(true, `Enviando documento ${i + 1} de ${files.length}...`);

      const presign = await api("POST", `/sessions/${session.sessionId}/documents/presign`, {
        nomeArquivoOriginal: f.name,
        tipoDocumento: "PROVA_DOCUMENTAL",
        contentType: type,
        tamanhoBytesEstimado: f.size,
      });

      const up = await fetch(`/upload?url=${encodeURIComponent(presign.uploadUrl)}`, {
        method: "PUT",
        headers: { "Content-Type": type },
        body: f,
      });
      if (!up.ok) throw new Error(`Falha no upload de "${f.name}" (${up.status}).`);

      await api("POST", `/sessions/${session.sessionId}/documents/${presign.documentId}/complete`, null, crypto.randomUUID());
    }

    setBusy(true, "Finalizando...");
    await api("POST", `/sessions/${session.sessionId}/finalize`, null, crypto.randomUUID());

    showResult(session);
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
});

$("again").addEventListener("click", () => {
  clearInterval(pollTimer);
  form.reset();
  files = [];
  renderFiles();
  fillTipos();
  $("count").textContent = "0";
  $("result").hidden = true;
  form.hidden = false;
  window.scrollTo({ top: 0 });
});

// ---------- resultado / acompanhamento ----------

function showResult(session) {
  form.hidden = true;
  $("result").hidden = false;
  $("protocolo").textContent = session.protocolo;
  $("sessionId").textContent = session.sessionId;
  renderSteps("QUEUED_FOR_PROCESSING");
  window.scrollTo({ top: 0 });

  const tick = async () => {
    try {
      const s = await api("GET", `/sessions/${session.sessionId}`);
      renderSteps(s.status);
      if (FINAL.includes(s.status)) clearInterval(pollTimer);
    } catch (err) {
      $("statusRaw").textContent = `Não foi possível consultar o status: ${err.message}`;
    }
  };
  clearInterval(pollTimer);
  pollTimer = setInterval(tick, 4000);
  tick();
}

function renderSteps(status) {
  const [current, failed] = STATUS_STEP[status] ?? [0, false];
  $("steps").innerHTML = STEPS.map((label, i) => {
    const cls = i < current ? "done" : i > current ? "todo" : failed ? "fail" : "doing";
    return `<li class="${cls}">${label}</li>`;
  }).join("");
  $("statusRaw").textContent = `Status atual: ${status}`;
}

// ---------- helpers ----------

async function api(method, path, body, idempotencyKey) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) {
    const msg = data.message || data.error || data.detail || text || res.statusText;
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

function contentTypeOf(f) {
  if (f.type) return f.type === "image/jpg" ? "image/jpeg" : f.type;
  const ext = f.name.split(".").pop().toLowerCase();
  return { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", tif: "image/tiff", tiff: "image/tiff" }[ext] || "";
}

function setBusy(busy, label) {
  $("submit").disabled = busy;
  $("submit").textContent = busy ? label : "Enviar para análise";
}

function showError(msg) { $("error").textContent = msg; $("error").hidden = false; }
function hideError() { $("error").hidden = true; }

function formatSize(n) {
  return n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
