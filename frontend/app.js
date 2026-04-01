const state = {
  source: createImageState("source"),
  target: createImageState("target"),
  jobId: null,
  pollTimer: null,
  pollRequestId: 0,
  pollRetries: 0,
  resultDownloadUrl: null,
  resultFileName: null,
};

const sourceInput = document.querySelector("#source-input");
const targetInput = document.querySelector("#target-input");
const outputFormat = document.querySelector("#output-format");
const runJobButton = document.querySelector("#run-job");
const jobStatus = document.querySelector("#job-status");
const resultStage = document.querySelector("#result-stage");
const resultStatus = document.querySelector("#result-status");
const downloadResultButton = document.querySelector("#download-result");

sourceInput.addEventListener("change", (event) => handleFilePicked("source", event));
targetInput.addEventListener("change", (event) => handleFilePicked("target", event));
runJobButton.addEventListener("click", createJob);
downloadResultButton.addEventListener("click", downloadResult);

function createImageState(kind) {
  return {
    kind,
    objectKey: null,
    previewUrl: null,
    faces: [],
    selectedIndex: null,
    requestId: 0,
    controller: null,
    isBusy: false,
  };
}

async function handleFilePicked(kind, event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const scope = state[kind];
  resetJobState();
  clearSlot(scope);

  if (!["image/jpeg", "image/png"].includes(file.type)) {
    setStatus(kind, "Only JPEG and PNG files are supported.");
    syncRunButton();
    event.target.value = "";
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    setStatus(kind, "Max file size is 10 MB.");
    syncRunButton();
    event.target.value = "";
    return;
  }

  if (scope.controller) {
    scope.controller.abort();
  }
  scope.requestId += 1;
  const requestId = scope.requestId;
  const controller = new AbortController();
  scope.controller = controller;
  scope.isBusy = true;
  scope.previewUrl = URL.createObjectURL(file);
  renderStage(kind);
  setStatus(kind, "Uploading image...");
  syncRunButton();

  try {
    const presign = await apiFetch("/api/uploads/presign", {
      method: "POST",
      body: JSON.stringify({
        kind,
        fileName: file.name,
        contentType: file.type,
        contentLength: file.size,
      }),
      signal: controller.signal,
    });
    if (!isActiveRequest(scope, requestId)) {
      return;
    }

    const uploadResponse = await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type,
      },
      body: file,
      signal: controller.signal,
    });
    if (!isActiveRequest(scope, requestId)) {
      return;
    }
    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.status}`);
    }

    scope.objectKey = presign.objectKey;
    setStatus(kind, "Detecting faces...");

    const detected = await apiFetch("/api/faces/detect", {
      method: "POST",
      body: JSON.stringify({
        imageKey: scope.objectKey,
      }),
      signal: controller.signal,
    });
    if (!isActiveRequest(scope, requestId)) {
      return;
    }

    scope.faces = detected.faces || [];
    scope.selectedIndex = scope.faces.length === 1 ? 0 : null;
    renderStage(kind);
    if (scope.faces.length === 0) {
      setStatus(kind, "No faces detected.");
    } else if (scope.selectedIndex !== null) {
      setStatus(kind, "One face detected and selected.");
    } else {
      setStatus(kind, `${scope.faces.length} faces detected. Click one box to choose.`);
    }
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    console.error(error);
    clearSlot(scope, { preserveController: true });
    setStatus(kind, error.message || "Upload failed.");
  } finally {
    if (isActiveRequest(scope, requestId)) {
      scope.isBusy = false;
      scope.controller = null;
    }
    event.target.value = "";
  }

  syncRunButton();
}

function renderStage(kind) {
  const scope = state[kind];
  const stage = document.querySelector(`#${kind}-stage`);
  stage.innerHTML = "";

  if (!scope.previewUrl) {
    stage.innerHTML = "<p class=\"hint\">No image selected yet.</p>";
    return;
  }

  const template = document.querySelector("#stage-template");
  const fragment = template.content.cloneNode(true);
  const image = fragment.querySelector(".preview-image");
  const layer = fragment.querySelector(".face-layer");

  image.addEventListener("load", () => {
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;

    scope.faces.forEach((face) => {
      const [x1, y1, x2, y2] = face.bbox;
      const box = document.createElement("button");
      box.type = "button";
      box.className = "face-box";
      if (scope.selectedIndex === face.index) {
        box.classList.add("is-selected");
      }
      box.style.left = `${(x1 / naturalWidth) * 100}%`;
      box.style.top = `${(y1 / naturalHeight) * 100}%`;
      box.style.width = `${((x2 - x1) / naturalWidth) * 100}%`;
      box.style.height = `${((y2 - y1) / naturalHeight) * 100}%`;

      const chip = document.createElement("span");
      chip.className = "face-chip";
      chip.textContent = `Face ${face.index}`;
      box.appendChild(chip);

      box.addEventListener("click", () => {
        scope.selectedIndex = face.index;
        renderStage(kind);
        setStatus(kind, `Face ${face.index} selected.`);
        syncRunButton();
      });
      layer.appendChild(box);
    });
  });
  image.alt = `${kind} preview`;
  image.src = scope.previewUrl;

  stage.appendChild(fragment);
}

async function createJob() {
  if (!isReady()) {
    return;
  }

  clearResult();
  runJobButton.disabled = true;
  jobStatus.textContent = "Queueing job...";
  setResultStatus("Waiting for the generated result...");

  try {
    const response = await apiFetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        sourceImageKey: state.source.objectKey,
        targetImageKey: state.target.objectKey,
        sourceFaceIndex: state.source.selectedIndex,
        targetFaceIndex: state.target.selectedIndex,
        outputFormat: outputFormat.value,
      }),
    });

    state.jobId = response.jobId;
    jobStatus.textContent = `Job ${response.jobId} queued. Polling for completion...`;
    beginPolling();
  } catch (error) {
    console.error(error);
    jobStatus.textContent = error.message || "Failed to create job.";
    syncRunButton();
  }
}

function beginPolling() {
  stopPolling();
  state.pollRequestId += 1;
  state.pollRetries = 0;
  schedulePoll(0, state.pollRequestId);
}

function schedulePoll(delayMs, requestId) {
  state.pollTimer = window.setTimeout(() => {
    pollJob(requestId);
  }, delayMs);
}

async function pollJob(requestId) {
  if (!state.jobId || requestId !== state.pollRequestId) {
    return;
  }

  try {
    const response = await apiFetch(`/api/jobs/${state.jobId}`, {
      method: "GET",
    });
    if (requestId !== state.pollRequestId) {
      return;
    }
    jobStatus.textContent = `Job status: ${response.status}`;
    state.pollRetries = 0;

    if (response.status === "completed") {
      stopPolling();
      renderResult(response);
      jobStatus.textContent = "Swap completed. Preview updated below.";
      syncRunButton();
      return;
    }

    if (response.status === "failed") {
      stopPolling();
      jobStatus.textContent = `Job failed: ${response.errorCode || "UNKNOWN_ERROR"}`;
      setResultStatus("Generation failed. Fix the issue and try again.");
      syncRunButton();
      return;
    }

    schedulePoll(3000, requestId);
  } catch (error) {
    console.error(error);
    if (requestId !== state.pollRequestId) {
      return;
    }
    state.pollRetries += 1;
    const delayMs = Math.min(3000 * (2 ** Math.min(state.pollRetries, 3)), 15000);
    jobStatus.textContent = `Temporary polling error. Retrying in ${Math.ceil(delayMs / 1000)}s...`;
    schedulePoll(delayMs, requestId);
  }
}

function isReady() {
  return (
    Boolean(state.source.objectKey) &&
    Boolean(state.target.objectKey) &&
    Number.isInteger(state.source.selectedIndex) &&
    Number.isInteger(state.target.selectedIndex) &&
    !state.source.isBusy &&
    !state.target.isBusy &&
    !state.pollTimer
  );
}

function syncRunButton() {
  runJobButton.disabled = !isReady();
}

function resetJobState() {
  state.jobId = null;
  stopPolling();
  state.pollRetries = 0;
  jobStatus.textContent = "Upload both images and select one face in each.";
  clearResult();
}

function stopPolling() {
  state.pollRequestId += 1;
  if (state.pollTimer) {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function clearSlot(scope, options = {}) {
  const { preserveController = false } = options;
  if (!preserveController && scope.controller) {
    scope.controller.abort();
    scope.controller = null;
  }
  if (scope.previewUrl) {
    URL.revokeObjectURL(scope.previewUrl);
  }
  scope.previewUrl = null;
  scope.objectKey = null;
  scope.faces = [];
  scope.selectedIndex = null;
  scope.isBusy = false;
  renderStage(scope.kind);
}

function isActiveRequest(scope, requestId) {
  return scope.requestId === requestId;
}

function setStatus(kind, message) {
  const status = document.querySelector(`#${kind}-status`);
  status.textContent = message;
}

function setResultStatus(message) {
  resultStatus.textContent = message;
}

function clearResult() {
  state.resultDownloadUrl = null;
  state.resultFileName = null;
  downloadResultButton.classList.add("hidden");
  downloadResultButton.disabled = false;
  downloadResultButton.textContent = "Download Result";
  resultStage.innerHTML =
    "<p class=\"hint\">The generated face swap will appear here when processing finishes.</p>";
  setResultStatus("Run a job to preview the generated image here.");
}

function renderResult(response) {
  state.resultDownloadUrl = response.downloadUrl;
  state.resultFileName = getResultFileName(response);

  const image = document.createElement("img");
  image.className = "result-image";
  image.alt = "Generated face swap result";
  image.src = response.downloadUrl;

  image.addEventListener("load", () => {
    setResultStatus("Preview loaded. Download the result before the temporary URL expires.");
  });
  image.addEventListener("error", () => {
    setResultStatus("Preview could not be loaded, but you can still try downloading the result.");
  });

  resultStage.replaceChildren(image);
  downloadResultButton.classList.remove("hidden");
}

async function downloadResult() {
  if (!state.resultDownloadUrl) {
    return;
  }

  downloadResultButton.disabled = true;
  downloadResultButton.textContent = "Preparing...";

  try {
    const response = await fetch(state.resultDownloadUrl);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = state.resultFileName || "face-swap-result.jpg";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (error) {
    console.error(error);
    setResultStatus(error.message || "Failed to download the generated result.");
  } finally {
    downloadResultButton.disabled = false;
    downloadResultButton.textContent = "Download Result";
  }
}

function getResultFileName(response) {
  const extension = response.resultImageKey?.split(".").pop() || outputFormat.value || "jpg";
  return `face-swap-result-${response.jobId}.${extension}`;
}

async function apiFetch(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Request failed: ${response.status}`);
  }
  return data;
}

renderStage("source");
renderStage("target");
resetJobState();
syncRunButton();
