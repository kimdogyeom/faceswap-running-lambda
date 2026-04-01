const DASHBOARD_ROUTE = document.documentElement.dataset.route === "dashboard";

if (DASHBOARD_ROUTE) {
  initDashboard();
}

function initDashboard() {
  document.title = "Dashboard | Face Swap Running on Lambda";

  const refs = {
    badge: document.querySelector("#dashboard-status-badge"),
    refresh: document.querySelector("#dashboard-refresh"),
    updated: document.querySelector("#dashboard-last-updated"),
    banner: document.querySelector("#dashboard-banner"),
    empty: document.querySelector("#dashboard-empty"),
    requests: document.querySelector("#metric-requests"),
    completed: document.querySelector("#metric-completed"),
    failed: document.querySelector("#metric-failed"),
    successRate: document.querySelector("#metric-success-rate"),
    failureRate: document.querySelector("#metric-failure-rate"),
    avgLatency: document.querySelector("#metric-avg-latency"),
    p95Latency: document.querySelector("#metric-p95-latency"),
    statusLabel: document.querySelector("#metric-status-label"),
    statusReason: document.querySelector("#metric-status-reason"),
    trendChart: document.querySelector("#trend-chart"),
    failureChart: document.querySelector("#failure-chart"),
  };

  const state = {
    snapshot: null,
    refreshTimer: null,
    requestId: 0,
    controller: null,
    isRefreshing: false,
    lastUpdatedAt: null,
  };

  refs.refresh.addEventListener("click", () => refreshDashboard(true));

  refreshDashboard(false);
  state.refreshTimer = window.setInterval(() => refreshDashboard(false), 60_000);

  window.addEventListener("beforeunload", () => {
    if (state.refreshTimer) {
      window.clearInterval(state.refreshTimer);
    }
    if (state.controller) {
      state.controller.abort();
    }
  });

  async function refreshDashboard(isManual) {
    if (state.isRefreshing) {
      return;
    }

    state.isRefreshing = true;
    setRefreshState(true, isManual);

    if (state.controller) {
      state.controller.abort();
    }

    const controller = new AbortController();
    state.controller = controller;
    const requestId = ++state.requestId;

    try {
      const snapshot = await fetchDashboardSnapshot(controller.signal);
      if (requestId !== state.requestId) {
        return;
      }
      state.snapshot = snapshot;
      state.lastUpdatedAt = new Date();
      renderDashboard(refs, snapshot, state.lastUpdatedAt);
      setBanner(refs.banner, snapshot.partialData ? "info" : null, snapshot.partialData ? "Showing partial data because one or more metric sources were unavailable." : "");
    } catch (error) {
      if (requestId !== state.requestId) {
        return;
      }
      console.error(error);

      if (state.snapshot) {
        setBanner(
          refs.banner,
          "warning",
          "Refresh failed. Showing the last successful snapshot until the next update.",
        );
        renderDashboard(refs, state.snapshot, state.lastUpdatedAt || new Date());
      } else {
        setBanner(refs.banner, "danger", error.message || "Failed to load dashboard metrics.");
        renderEmptyState(refs.empty, true);
        renderLoadingDashboard(refs);
      }
    } finally {
      if (requestId === state.requestId) {
        state.isRefreshing = false;
        state.controller = null;
        setRefreshState(false, false);
      }
    }
  }
}

async function fetchDashboardSnapshot(signal) {
  const response = await fetch("/api/metrics/dashboard", {
    method: "GET",
    cache: "no-store",
    signal,
    headers: {
      "Content-Type": "application/json",
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Request failed: ${response.status}`);
  }
  return data;
}

function renderDashboard(refs, snapshot, updatedAt) {
  const summary = snapshot.summary || {};
  const status = snapshot.status || {};
  const timeseries = Array.isArray(snapshot.timeseries) ? snapshot.timeseries : [];
  const failures = Array.isArray(snapshot.failureDistribution) ? snapshot.failureDistribution : [];

  setBadge(refs.badge, status.level, status.label);
  refs.updated.textContent = formatUpdatedAt(updatedAt);

  refs.requests.textContent = formatCount(summary.requests);
  refs.completed.textContent = formatCount(summary.completed);
  refs.failed.textContent = formatCount(summary.failed);
  refs.successRate.textContent = formatPercent(summary.successRate);
  refs.failureRate.textContent = formatPercent(summary.failureRate);
  refs.avgLatency.textContent = formatDuration(summary.averageLatencyMs);
  refs.p95Latency.textContent = formatDuration(summary.p95LatencyMs);
  refs.statusLabel.textContent = status.label || "Unknown";
  refs.statusReason.textContent = status.reason || "No status explanation available.";

  renderTrendChart(refs.trendChart, timeseries);
  renderFailureChart(refs.failureChart, failures);
  renderEmptyState(refs.empty, isEmptySnapshot(snapshot));
}

function renderLoadingDashboard(refs) {
  refs.badge.className = "status-pill status-pill-loading";
  refs.badge.textContent = "Loading";
  refs.updated.textContent = "Loading dashboard metrics...";
  refs.requests.textContent = "--";
  refs.completed.textContent = "--";
  refs.failed.textContent = "--";
  refs.successRate.textContent = "--";
  refs.failureRate.textContent = "--";
  refs.avgLatency.textContent = "--";
  refs.p95Latency.textContent = "--";
  refs.statusLabel.textContent = "--";
  refs.statusReason.textContent = "Waiting for the first snapshot.";
  renderTrendChart(refs.trendChart, []);
  renderFailureChart(refs.failureChart, []);
}

function renderTrendChart(svg, timeseries) {
  clearNode(svg);
  const width = 1000;
  const height = 320;
  const margins = { top: 28, right: 24, bottom: 44, left: 54 };
  const plotWidth = width - margins.left - margins.right;
  const plotHeight = height - margins.top - margins.bottom;
  const slotWidth = plotWidth / Math.max(timeseries.length || 24, 1);
  const barWidth = Math.max(8, slotWidth * 0.22);
  const barGap = Math.max(3, slotWidth * 0.06);
  const series = [
    { key: "requests", label: "Requests", color: "#ff6a3d" },
    { key: "completed", label: "Completed", color: "#0d7c66" },
    { key: "failed", label: "Failed", color: "#b33c2f" },
  ];

  const maxValue = Math.max(
    1,
    ...timeseries.flatMap((point) => [point.requests || 0, point.completed || 0, point.failed || 0]),
  );

  appendSvg(svg, "rect", {
    x: 0,
    y: 0,
    width,
    height,
    rx: 20,
    ry: 20,
    fill: "rgba(255,255,255,0.22)",
  });

  for (let step = 0; step <= 4; step += 1) {
    const ratio = step / 4;
    const y = margins.top + plotHeight - plotHeight * ratio;
    appendSvg(svg, "line", {
      x1: margins.left,
      y1: y,
      x2: width - margins.right,
      y2: y,
      stroke: "rgba(30, 28, 25, 0.08)",
      "stroke-width": 1,
    });
    appendSvg(svg, "text", {
      x: margins.left - 10,
      y: y + 4,
      "text-anchor": "end",
      fill: "#645e56",
      "font-size": 12,
      "font-family": "Space Grotesk, sans-serif",
    }, formatAxisCount(maxValue * ratio));
  }

  timeseries.forEach((point, index) => {
    const slotStart = margins.left + index * slotWidth;
    const groupWidth = series.length * barWidth + (series.length - 1) * barGap;
    const groupStart = slotStart + (slotWidth - groupWidth) / 2;
    const values = [point.requests || 0, point.completed || 0, point.failed || 0];

    series.forEach((item, seriesIndex) => {
      const value = values[seriesIndex];
      const barHeight = (value / maxValue) * plotHeight;
      const x = groupStart + seriesIndex * (barWidth + barGap);
      const y = margins.top + plotHeight - barHeight;

      const bar = appendSvg(svg, "rect", {
        x,
        y,
        width: barWidth,
        height: Math.max(barHeight, 1),
        rx: 8,
        ry: 8,
        fill: item.color,
        opacity: seriesIndex === 2 ? 0.9 : 0.95,
      });

      appendSvg(svg, "title", {}, `${item.label}: ${formatCount(value)} at bucket ${index + 1}`, bar);
    });

    if (index % 6 === 0 || index === timeseries.length - 1) {
      const label = formatHourLabel(
        point.bucketStart || point.bucketStartAt || point.time || point.timestamp || null,
      );
      appendSvg(svg, "text", {
        x: slotStart + slotWidth / 2,
        y: height - 16,
        "text-anchor": "middle",
        fill: "#645e56",
        "font-size": 12,
        "font-family": "Space Grotesk, sans-serif",
      }, label);
    }
  });

  appendTrendLegend(svg.parentElement, series);
}

function renderFailureChart(container, failures) {
  clearNode(container);

  const total = failures.reduce((sum, item) => sum + (item.count || 0), 0);
  const summary = document.createElement("p");
  summary.className = "failure-summary";
  summary.textContent =
    total > 0
      ? `${formatCount(total)} failures in the last 24 hours.`
      : "No failures were recorded in the last 24 hours.";
  container.appendChild(summary);

  if (!failures.length || total === 0) {
    const empty = document.createElement("div");
    empty.className = "failure-empty";
    empty.textContent = "Failure code distribution will appear here once the first failure occurs.";
    container.appendChild(empty);
    return;
  }

  failures.slice(0, 6).forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "failure-row";

    const head = document.createElement("div");
    head.className = "failure-row-head";

    const code = document.createElement("span");
    code.className = "failure-code";
    code.textContent = item.code || `FAIL_${index + 1}`;

    const meta = document.createElement("span");
    meta.className = "failure-meta";
    meta.textContent = `${formatCount(item.count || 0)} · ${formatPercent(item.share)}`;

    const track = document.createElement("div");
    track.className = "failure-track";

    const fill = document.createElement("div");
    fill.className = "failure-fill";
    fill.style.width = `${Math.max(4, Math.round((item.share || 0) * 100))}%`;

    track.appendChild(fill);
    head.append(code, meta);
    row.append(head, track);
    container.appendChild(row);
  });
}

function renderEmptyState(node, show) {
  node.classList.toggle("hidden", !show);
}

function isEmptySnapshot(snapshot) {
  const summary = snapshot.summary || {};
  const timeseries = Array.isArray(snapshot.timeseries) ? snapshot.timeseries : [];
  const failures = Array.isArray(snapshot.failureDistribution) ? snapshot.failureDistribution : [];
  const counts = [summary.requests, summary.completed, summary.failed].map((value) => Number(value || 0));
  const hasActivity = counts.some((value) => value > 0);
  const hasTrend = timeseries.some((item) => {
    return Number(item.requests || 0) > 0 || Number(item.completed || 0) > 0 || Number(item.failed || 0) > 0;
  });
  return !hasActivity && !hasTrend && failures.length === 0;
}

function setBadge(node, level, label) {
  const normalized = normalizeStatusLevel(level);
  node.className = `status-pill status-pill-${normalized}`;
  node.textContent = label || normalized.toUpperCase();
}

function normalizeStatusLevel(level) {
  if (level === "healthy" || level === "degraded" || level === "down") {
    return level;
  }
  return "loading";
}

function setRefreshState(isRefreshing, isManual) {
  const button = document.querySelector("#dashboard-refresh");
  if (!button) {
    return;
  }
  button.disabled = isRefreshing;
  button.textContent = isRefreshing ? (isManual ? "Refreshing..." : "Updating...") : "Refresh";
}

function setBanner(node, tone, message) {
  if (!message) {
    node.className = "banner hidden";
    node.textContent = "";
    return;
  }

  node.className = `banner ${tone ? `is-${tone}` : ""}`.trim();
  node.textContent = message;
}

function appendTrendLegend(parent, series) {
  const existing = parent.querySelector(".chart-legend");
  if (existing) {
    existing.remove();
  }

  const legend = document.createElement("div");
  legend.className = "chart-legend";
  series.forEach((item) => {
    const entry = document.createElement("span");
    entry.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = item.color;
    entry.append(swatch, document.createTextNode(item.label));
    legend.appendChild(entry);
  });
  parent.appendChild(legend);
}

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function appendSvg(parent, tagName, attrs = {}, textContent, referenceNode) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tagName);
  Object.entries(attrs).forEach(([key, value]) => {
    el.setAttribute(key, String(value));
  });
  if (typeof textContent === "string" && textContent.length > 0) {
    el.textContent = textContent;
  }
  if (referenceNode) {
    referenceNode.appendChild(el);
  } else {
    parent.appendChild(el);
  }
  return el;
}

function formatCount(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }
  return new Intl.NumberFormat().format(Number(value));
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatDuration(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }
  const duration = Number(value);
  if (duration < 1000) {
    return `${Math.round(duration)} ms`;
  }
  const seconds = duration / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)} s`;
}

function formatAxisCount(value) {
  const rounded = Math.round(Number(value) || 0);
  return formatCount(rounded);
}

function formatHourLabel(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    hour12: false,
  }).format(date);
}

function formatUpdatedAt(value) {
  const date = value instanceof Date ? value : new Date();
  return `Last updated ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)}`;
}
