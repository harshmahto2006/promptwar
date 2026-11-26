/**
 * HemoPulse Multi-Hospital Platform & Interactive Network Controller
 */
(function (global) {
  'use strict';

  const Data = global.HemoNetworkData;
  const Engine = global.HemoPredictionEngine;
  const STORAGE_KEY = 'hemopulse_network_state_v2';

  const RISK_COLORS = {
    critical: '#ef4444',
    high: '#f97316',
    watch: '#f59e0b',
    stable: '#10b981'
  };

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createDefaultState() {
    return {
      nodes: deepClone(Data.INITIAL_NODES),
      links: deepClone(Data.INITIAL_LINKS),
      emergencies: deepClone(Data.INITIAL_EMERGENCIES),
      consumptionEvents: deepClone(Data.INITIAL_CONSUMPTION_EVENTS),
      portalHospitalId: 'ALL',
      demandPatternId: 'steady_baseline',
      customPatterns: {},
      scenarioId: 'baseline',
      horizonHours: 48,
      selectedBloodLens: 'ALL',
      selectedNodeId: 'HOSP-TRAUMA-N',
      selectedBloodType: 'O-',
      searchQuery: '',
      consumptionSearchQuery: '',
      severityFilter: 'all',
      logs: [
        {
          time: '09:34',
          level: 'critical',
          text: 'Code Red EMG-2043 logged at Southbay Coastal Medical Center (6u A- needed, contact Dr. Priya Deshmukh).'
        },
        {
          time: '09:28',
          level: 'info',
          text: 'Code Amber EMG-2042 flagged at Eastside Mercy (5u B- needed, contact Elena Rostova, RN).'
        },
        {
          time: '09:22',
          level: 'info',
          text: 'Transfusion TX-8814 logged at Northgate Level-1 Trauma Hospital (4u O-, Trauma Bay 1).'
        },
        {
          time: '09:15',
          level: 'critical',
          text: 'Code Red MTP EMG-2041 activated at Northgate Level-1 Trauma (8u O- needed, contact Dr. Marcus Vance).'
        }
      ]
    };
  }

  function loadState() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultState();
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        !Array.isArray(parsed.nodes) ||
        !Array.isArray(parsed.emergencies) ||
        !Array.isArray(parsed.consumptionEvents)
      ) {
        return createDefaultState();
      }
      if (!parsed.demandPatternId) parsed.demandPatternId = 'steady_baseline';
      if (!parsed.customPatterns) parsed.customPatterns = {};
      return parsed;
    } catch (err) {
      return createDefaultState();
    }
  }

  let state = loadState();
  let lastMatrix = null;
  let toastTimer = null;

  function saveState() {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }
    } catch (err) {
      // Ignore storage quota errors
    }
  }

  function nowTimeLabel() {
    const d = new Date();
    return (
      String(d.getHours()).padStart(2, '0') +
      ':' +
      String(d.getMinutes()).padStart(2, '0')
    );
  }

  function nowTimestampLabel() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd + ' ' + nowTimeLabel();
  }

  function addLog(text, level) {
    state.logs.unshift({
      time: nowTimeLabel(),
      level: level || 'info',
      text: text
    });
    if (state.logs.length > 40) state.logs.length = 40;
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.add('hidden');
    }, 3200);
  }

  function findNode(nodeId) {
    for (let i = 0; i < state.nodes.length; i++) {
      if (state.nodes[i].id === nodeId) return state.nodes[i];
    }
    return state.nodes[0];
  }

  function findEmergency(emgId) {
    for (let i = 0; i < state.emergencies.length; i++) {
      if (state.emergencies[i].id === emgId) return state.emergencies[i];
    }
    return null;
  }

  function getActiveScenario() {
    return Data.SCENARIOS[state.scenarioId] || Data.SCENARIOS.baseline;
  }

  function getAllDemandPatterns() {
    return Object.assign({}, Data.EMERGENCY_DEMAND_PATTERNS, state.customPatterns || {});
  }

  function getActiveDemandPattern() {
    const all = getAllDemandPatterns();
    return all[state.demandPatternId] || Data.EMERGENCY_DEMAND_PATTERNS.steady_baseline;
  }

  function renderHeaderControls() {
    const portalSelect = document.getElementById('portalSelect');
    portalSelect.innerHTML =
      '<option value="ALL">All Hospitals — Regional Command (' +
      state.nodes.length +
      ' Nodes)</option>' +
      state.nodes
        .map(function (n) {
          return (
            '<option value="' +
            escapeHtml(n.id) +
            '">' +
            escapeHtml(n.name + ' [' + n.type + ']') +
            '</option>'
          );
        })
        .join('');
    portalSelect.value = state.portalHospitalId || 'ALL';

    const allPatterns = getAllDemandPatterns();
    const patternSelect = document.getElementById('patternSelect');
    patternSelect.innerHTML = Object.keys(allPatterns)
      .map(function (id) {
        return (
          '<option value="' +
          escapeHtml(id) +
          '">' +
          escapeHtml(allPatterns[id].name) +
          '</option>'
        );
      })
      .join('');
    patternSelect.value = getActiveDemandPattern().id;

    const scenarioSelect = document.getElementById('scenarioSelect');
    if (scenarioSelect.options.length === 0) {
      Object.keys(Data.SCENARIOS).forEach(function (id) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = Data.SCENARIOS[id].name;
        scenarioSelect.appendChild(opt);
      });
    }
    scenarioSelect.value = state.scenarioId;
    document.getElementById('horizonSelect').value = String(state.horizonHours);

    const sc = getActiveScenario();
    const pat = getActiveDemandPattern();
    const portalLabel =
      state.portalHospitalId === 'ALL'
        ? 'Regional Network Command (All ' + state.nodes.length + ' Facilities)'
        : 'Hospital Portal: ' + findNode(state.portalHospitalId).name;

    const banner = document.getElementById('scenarioBanner');
    banner.className =
      'scenario-banner' +
      (sc.id !== 'baseline' || pat.id !== 'steady_baseline' ? ' scenario-warning' : '');
    banner.innerHTML =
      '<span><strong>Workspace:</strong> ' +
      escapeHtml(portalLabel) +
      ' &bull; <strong>Demand Pattern:</strong> ' +
      escapeHtml(pat.name) +
      ' &bull; <strong>Scenario:</strong> ' +
      escapeHtml(sc.name) +
      '</span>' +
      '<span>Pattern Peak &times;' +
      Number(pat.peakMultiplier || 1).toFixed(2) +
      ' | Demand &times;' +
      sc.demandFactor.toFixed(2) +
      ' | Supply &times;' +
      sc.supplyFactor.toFixed(2) +
      '</span>';
  }

  function renderKPIs(matrix) {
    const isFilteredPortal = state.portalHospitalId !== 'ALL';
    const activeEmergencies = state.emergencies.filter(function (e) {
      if (e.status !== 'active') return false;
      if (isFilteredPortal && e.needLocation && e.needLocation.nodeId !== state.portalHospitalId) {
        return false;
      }
      return true;
    });

    document.getElementById('kpiEmergencies').textContent = String(activeEmergencies.length);
    const totalUrgentUnits = activeEmergencies.reduce(function (sum, e) {
      return sum + Number(e.unitsNeeded || 0);
    }, 0);
    document.getElementById('kpiEmergenciesSub').textContent =
      totalUrgentUnits + ' emergency units requested';

    if (isFilteredPortal) {
      const nodeReport = matrix.byNode[state.portalHospitalId];
      let critCount = 0;
      Data.BLOOD_TYPES.forEach(function (bt) {
        if (nodeReport.bloodPredictions[bt].riskLevel === 'critical') critCount++;
      });
      document.getElementById('kpiCriticalCells').textContent = String(critCount);
      document.getElementById('kpiCriticalSub').textContent = 'Critical blood types at selected hospital';

      document.getElementById('kpiHospitalsCount').textContent = '1 / ' + state.nodes.length;
      document.getElementById('kpiHospitalsSub').textContent =
        nodeReport.totalNodeUnits + ' units on-hand at portal';

      document.getElementById('kpiSevenDayConsumed').textContent =
        nodeReport.totalNode7dConsumed + ' u';
      document.getElementById('kpiSevenDaySub').textContent =
        '7-day local transfusion volume';

      const worstLocal = nodeReport.bloodPredictions[nodeReport.worstBloodType];
      const stockoutText =
        worstLocal.hoursToStockout === null
          ? '>' + state.horizonHours + 'h'
          : worstLocal.hoursToStockout === 0
          ? 'NOW (0h)'
          : worstLocal.hoursToStockout + 'h';
      document.getElementById('kpiEarliestStockout').textContent = stockoutText;
      document.getElementById('kpiEarliestSub').textContent =
        worstLocal.bloodType + ' at ' + nodeReport.node.name;
      return;
    }

    document.getElementById('kpiCriticalCells').textContent = String(matrix.kpis.criticalAlerts);
    document.getElementById('kpiCriticalSub').textContent =
      matrix.kpis.highRiskAlerts + ' additional high-risk pairs';

    document.getElementById('kpiHospitalsCount').textContent =
      matrix.kpis.hospitalCount + ' + ' + matrix.kpis.hubCount + ' Hubs';
    document.getElementById('kpiHospitalsSub').textContent =
      matrix.kpis.totalUnits + ' total blood units on network';

    document.getElementById('kpiSevenDayConsumed').textContent =
      matrix.kpis.total7dConsumed + ' u';
    document.getElementById('kpiSevenDaySub').textContent =
      state.consumptionEvents.length + ' recent ledger events';

    const worst = matrix.kpis.highestRiskCell;
    if (worst) {
      const stockoutText =
        worst.hoursToStockout === null
          ? '>' + state.horizonHours + 'h'
          : worst.hoursToStockout === 0
          ? 'NOW (0h)'
          : worst.hoursToStockout + 'h';
      document.getElementById('kpiEarliestStockout').textContent = stockoutText;
      document.getElementById('kpiEarliestSub').textContent =
        worst.bloodType + ' at ' + worst.nodeName;
    }
  }

  function renderHospitalDirectory(matrix) {
    const grid = document.getElementById('hospitalCardsGrid');
    grid.innerHTML = state.nodes
      .map(function (node) {
        const rep = matrix.byNode[node.id];
        const isPortal = state.portalHospitalId === node.id;
        const worstPred = rep.bloodPredictions[rep.worstBloodType];
        const stockoutBadge =
          worstPred.hoursToStockout !== null ? worstPred.hoursToStockout + 'h' : 'OK';

        return (
          '<article class="hosp-card' +
          (isPortal ? ' active-portal' : '') +
          '" data-portal-node="' +
          escapeHtml(node.id) +
          '">' +
          '<div class="hosp-card-top">' +
          '<div><h3>' +
          escapeHtml(node.name) +
          '</h3><div class="hosp-meta">' +
          escapeHtml(node.hospitalTier || node.type) +
          (node.bedCapacity ? ' &bull; ' + node.bedCapacity + ' beds' : '') +
          '</div></div>' +
          '<span class="risk-pill risk-' +
          escapeHtml(rep.worstRiskLevel) +
          '">' +
          escapeHtml(rep.worstBloodType + ' ' + stockoutBadge) +
          '</span>' +
          '</div>' +
          '<div class="hosp-stats">' +
          '<div><span>Stock</span><strong>' +
          rep.totalNodeUnits +
          ' u</strong></div>' +
          '<div><span>7d Used</span><strong>' +
          rep.totalNode7dConsumed +
          ' u</strong></div>' +
          '<div><span>Zone</span><strong>' +
          escapeHtml(node.zone) +
          '</strong></div>' +
          '</div>' +
          '<div class="hosp-card-actions">' +
          '<span>' +
          escapeHtml(node.contact.name + ' &bull; ' + node.contact.phone) +
          '</span>' +
          '<button type="button" class="btn ' +
          (isPortal ? 'btn-primary' : 'btn-secondary') +
          ' btn-xs" data-portal-btn="' +
          escapeHtml(node.id) +
          '">' +
          (isPortal ? 'Active Portal' : 'Open Portal') +
          '</button>' +
          '</div>' +
          '</article>'
        );
      })
      .join('');
  }

  function renderBloodTypeBar(matrix) {
    const container = document.getElementById('bloodTypePills');
    const summaryMap = {};
    matrix.bloodTypeSummary.forEach(function (s) {
      summaryMap[s.bloodType] = s;
    });

    const items = ['ALL'].concat(Data.BLOOD_TYPES);
    container.innerHTML = items
      .map(function (bt) {
        const isActive = state.selectedBloodLens === bt;
        if (bt === 'ALL') {
          return (
            '<button type="button" class="blood-pill' +
            (isActive ? ' active' : '') +
            '" data-lens="ALL">All Types</button>'
          );
        }
        const info = summaryMap[bt];
        let dotColor = RISK_COLORS.stable;
        if (info.maxRiskScore >= 75) dotColor = RISK_COLORS.critical;
        else if (info.maxRiskScore >= 52) dotColor = RISK_COLORS.high;
        else if (info.maxRiskScore >= 32) dotColor = RISK_COLORS.watch;

        return (
          '<button type="button" class="blood-pill' +
          (isActive ? ' active' : '') +
          '" data-lens="' +
          bt +
          '"><span class="pill-dot" style="background:' +
          dotColor +
          '"></span>' +
          bt +
          ' <span style="opacity:.7;font-weight:500">(' +
          info.totalUnits +
          'u)</span></button>'
        );
      })
      .join('');

    const compatStrip = document.getElementById('compatibilityStrip');
    const targetBt =
      state.selectedBloodLens !== 'ALL' ? state.selectedBloodLens : state.selectedBloodType;
    const compat = Engine.getCompatibleDonorTypes(targetBt);
    compatStrip.innerHTML =
      'Compatible RBC donors for <strong>' +
      escapeHtml(targetBt) +
      '</strong>: ' +
      compat
        .map(function (c, idx) {
          return (
            '<span class="compat-chip">' +
            escapeHtml(c) +
            (idx === 0 ? ' (Exact)' : '') +
            '</span>'
          );
        })
        .join('');
  }

  function renderNetworkMap(matrix) {
    const svg = document.getElementById('networkSvg');
    const scenario = getActiveScenario();
    const activeEmergencies = state.emergencies.filter(function (e) {
      return e.status === 'active';
    });

    let html = '';
    html += '<defs>';
    html +=
      '<pattern id="gridPattern" width="50" height="50" patternUnits="userSpaceOnUse">' +
      '<path d="M 50 0 L 0 0 0 50" fill="none" stroke="rgba(148,163,184,0.07)" stroke-width="1"/>' +
      '</pattern>';
    html += '</defs>';
    html += '<rect width="1000" height="580" fill="url(#gridPattern)"/>';

    state.links.forEach(function (pair) {
      const a = findNode(pair[0]);
      const b = findNode(pair[1]);
      if (!a || !b) return;
      const metrics = Engine.computeRouteMetrics(a, b, scenario);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      html +=
        '<line x1="' +
        a.x +
        '" y1="' +
        a.y +
        '" x2="' +
        b.x +
        '" y2="' +
        b.y +
        '" stroke="rgba(56, 189, 248, 0.22)" stroke-width="2" />';
      html +=
        '<text x="' +
        midX +
        '" y="' +
        (midY - 4) +
        '" fill="#64748b" font-size="10" text-anchor="middle">' +
        metrics.etaMinutes +
        'm</text>';
    });

    activeEmergencies.forEach(function (emg) {
      if (state.selectedBloodLens !== 'ALL' && emg.bloodType !== state.selectedBloodLens) return;
      const routes = Engine.recommendDispatchRoutes(
        emg,
        state.nodes,
        state.emergencies,
        scenario,
        getActiveDemandPattern()
      );
      if (routes.length === 0) return;
      const best = routes[0];
      const donor = findNode(best.donorNodeId);
      const target = emg.needLocation;
      if (!donor || !target) return;
      const cx = (donor.x + target.x) / 2;
      const cy = Math.min(donor.y, target.y) - 42;
      html +=
        '<path class="dispatch-arc" d="M ' +
        donor.x +
        ' ' +
        donor.y +
        ' Q ' +
        cx +
        ' ' +
        cy +
        ' ' +
        target.x +
        ' ' +
        target.y +
        '"/>';
    });

    state.nodes.forEach(function (node) {
      const nodeReport = matrix.byNode[node.id];
      const focusBt =
        state.selectedBloodLens !== 'ALL'
          ? state.selectedBloodLens
          : nodeReport.worstBloodType;
      const pred = nodeReport.bloodPredictions[focusBt];
      const riskLevel =
        state.selectedBloodLens !== 'ALL' ? pred.riskLevel : nodeReport.worstRiskLevel;
      const color = RISK_COLORS[riskLevel] || RISK_COLORS.stable;
      const isSelected =
        state.selectedNodeId === node.id || state.portalHospitalId === node.id;
      const radius = node.type === 'Regional Hub' ? 27 : 22;
      const dimmed =
        state.portalHospitalId !== 'ALL' &&
        state.portalHospitalId !== node.id &&
        node.type !== 'Regional Hub';

      const stockLabel =
        state.selectedBloodLens !== 'ALL'
          ? pred.currentUnits + 'u ' + focusBt
          : nodeReport.totalNodeUnits + 'u';

      const stockoutChip =
        pred.hoursToStockout !== null
          ? focusBt + ' out in ' + pred.hoursToStockout + 'h'
          : focusBt + ' ' + pred.predictedUnitsAtHorizon + 'u @' + state.horizonHours + 'h';

      html +=
        '<g class="svg-node" style="opacity:' +
        (dimmed ? '0.58' : '1') +
        '" data-node-id="' +
        escapeHtml(node.id) +
        '" data-bt="' +
        escapeHtml(focusBt) +
        '">';
      if (isSelected) {
        html +=
          '<circle cx="' +
          node.x +
          '" cy="' +
          node.y +
          '" r="' +
          (radius + 9) +
          '" fill="none" stroke="#22d3ee" stroke-width="2.2" stroke-dasharray="4 3"/>';
      }
      html +=
        '<circle class="node-ring" cx="' +
        node.x +
        '" cy="' +
        node.y +
        '" r="' +
        radius +
        '" fill="#0f172a" stroke="' +
        color +
        '" stroke-width="3.2"/>';
      html +=
        '<text x="' +
        node.x +
        '" y="' +
        (node.y + 4) +
        '" fill="#f8fafc" font-size="11" font-weight="700" text-anchor="middle">' +
        escapeHtml(stockLabel) +
        '</text>';
      html +=
        '<text x="' +
        node.x +
        '" y="' +
        (node.y + radius + 15) +
        '" fill="#e2e8f0" font-size="11" font-weight="700" text-anchor="middle">' +
        escapeHtml(node.name) +
        '</text>';
      html +=
        '<text x="' +
        node.x +
        '" y="' +
        (node.y + radius + 28) +
        '" fill="' +
        color +
        '" font-size="10" font-weight="600" text-anchor="middle">' +
        escapeHtml(stockoutChip + ' • ' + node.contact.phone) +
        '</text>';
      html += '</g>';
    });

    activeEmergencies.forEach(function (emg, idx) {
      const loc = emg.needLocation;
      if (!loc) return;
      const offsetX = loc.nodeId ? 25 + (idx % 2) * 12 : 0;
      const offsetY = loc.nodeId ? -26 : 0;
      const px = loc.x + offsetX;
      const py = loc.y + offsetY;
      const isCrit = emg.severity === 'critical';
      const pinColor = isCrit ? '#ef4444' : '#f59e0b';

      html +=
        '<g class="svg-emg-pin" data-emg-id="' +
        escapeHtml(emg.id) +
        '">';
      html +=
        '<circle cx="' +
        px +
        '" cy="' +
        py +
        '" r="15" fill="' +
        (isCrit ? 'rgba(239,68,68,0.24)' : 'rgba(245,158,11,0.22)') +
        '"/>';
      html +=
        '<polygon points="' +
        px +
        ',' +
        (py - 11) +
        ' ' +
        (px + 11) +
        ',' +
        py +
        ' ' +
        px +
        ',' +
        (py + 11) +
        ' ' +
        (px - 11) +
        ',' +
        py +
        '" fill="' +
        pinColor +
        '" stroke="#ffffff" stroke-width="1.8"/>';
      html +=
        '<text x="' +
        px +
        '" y="' +
        (py + 3.5) +
        '" fill="#ffffff" font-size="9" font-weight="800" text-anchor="middle">' +
        escapeHtml(emg.bloodType) +
        '</text>';
      html +=
        '<text x="' +
        (px + 14) +
        '" y="' +
        (py - 4) +
        '" fill="#fecaca" font-size="10" font-weight="700">' +
        escapeHtml(emg.id + ': ' + emg.unitsNeeded + 'u ' + emg.bloodType) +
        '</text>';
      html += '</g>';
    });

    svg.innerHTML = html;
  }

  function renderForecastChart(matrix) {
    const node = findNode(state.selectedNodeId);
    const bt =
      state.selectedBloodLens !== 'ALL' ? state.selectedBloodLens : state.selectedBloodType;
    const pred = matrix.byNode[node.id].bloodPredictions[bt];

    document.getElementById('forecastTitle').textContent =
      bt + ' Shortage Forecast — ' + node.name;
    document.getElementById('forecastSubtitle').textContent =
      '0–' +
      state.horizonHours +
      'h trajectory calibrated from 7d consumption history (' +
      pred.historicalMetrics.avgDaily7d +
      'u/day)';

    const riskBadge = document.getElementById('forecastRiskBadge');
    riskBadge.textContent = pred.riskLevel.toUpperCase() + ' (' + pred.riskScore + '/100)';
    riskBadge.className = 'risk-pill risk-' + pred.riskLevel;

    const W = 540;
    const H = 230;
    const pad = { top: 18, right: 20, bottom: 30, left: 40 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const traj = pred.trajectory;
    let minVal = 0;
    let maxVal = Math.max(pred.safetyBuffer + 6, pred.currentUnits + 4);
    traj.forEach(function (pt) {
      if (pt.lowUnits < minVal) minVal = pt.lowUnits;
      if (pt.highUnits > maxVal) maxVal = pt.highUnits;
    });
    const range = Math.max(10, maxVal - minVal);

    function xPos(hr) {
      return pad.left + (hr / state.horizonHours) * plotW;
    }

    function yPos(val) {
      return pad.top + ((maxVal - val) / range) * plotH;
    }

    let svgHtml = '';
    const yZero = yPos(0);
    const ySafe = yPos(pred.safetyBuffer);

    if (minVal < 0) {
      svgHtml +=
        '<rect x="' +
        pad.left +
        '" y="' +
        yZero +
        '" width="' +
        plotW +
        '" height="' +
        Math.max(0, pad.top + plotH - yZero) +
        '" fill="rgba(239,68,68,0.14)"/>';
    }

    [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
      const val = Math.round(minVal + t * range);
      const y = yPos(val);
      svgHtml +=
        '<line x1="' +
        pad.left +
        '" y1="' +
        y +
        '" x2="' +
        (W - pad.right) +
        '" y2="' +
        y +
        '" stroke="rgba(148,163,184,0.12)"/>';
      svgHtml +=
        '<text x="' +
        (pad.left - 6) +
        '" y="' +
        (y + 3) +
        '" fill="#64748b" font-size="10" text-anchor="end">' +
        val +
        '</text>';
    });

    const upperPts = traj.map(function (pt) {
      return xPos(pt.hour).toFixed(1) + ',' + yPos(pt.highUnits).toFixed(1);
    });
    const lowerPts = traj
      .slice()
      .reverse()
      .map(function (pt) {
        return xPos(pt.hour).toFixed(1) + ',' + yPos(pt.lowUnits).toFixed(1);
      });
    svgHtml +=
      '<polygon points="' +
      upperPts.concat(lowerPts).join(' ') +
      '" fill="rgba(6, 182, 212, 0.16)"/>';

    svgHtml +=
      '<line x1="' +
      pad.left +
      '" y1="' +
      ySafe +
      '" x2="' +
      (W - pad.right) +
      '" y2="' +
      ySafe +
      '" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="5 4"/>';
    svgHtml +=
      '<text x="' +
      (W - pad.right - 4) +
      '" y="' +
      (ySafe - 5) +
      '" fill="#fbbf24" font-size="10" text-anchor="end">Safety Buffer (' +
      pred.safetyBuffer +
      'u)</text>';

    svgHtml +=
      '<line x1="' +
      pad.left +
      '" y1="' +
      yZero +
      '" x2="' +
      (W - pad.right) +
      '" y2="' +
      yZero +
      '" stroke="#ef4444" stroke-width="1.4"/>';

    const linePath = traj
      .map(function (pt, idx) {
        return (
          (idx === 0 ? 'M ' : 'L ') +
          xPos(pt.hour).toFixed(1) +
          ' ' +
          yPos(pt.expectedUnits).toFixed(1)
        );
      })
      .join(' ');
    const lineColor = RISK_COLORS[pred.riskLevel] || '#22d3ee';
    svgHtml +=
      '<path d="' +
      linePath +
      '" fill="none" stroke="' +
      lineColor +
      '" stroke-width="2.8" stroke-linecap="round"/>';

    if (pred.hoursToStockout !== null) {
      const sx = xPos(pred.hoursToStockout);
      svgHtml +=
        '<circle cx="' +
        sx +
        '" cy="' +
        yZero +
        '" r="5" fill="#ef4444" stroke="#ffffff" stroke-width="1.5"/>';
      svgHtml +=
        '<text x="' +
        Math.min(W - 70, sx + 8) +
        '" y="' +
        (yZero - 8) +
        '" fill="#fca5a5" font-size="10.5" font-weight="700">Stockout @ ' +
        pred.hoursToStockout +
        'h</text>';
    }

    const step = state.horizonHours <= 24 ? 6 : 12;
    for (let h = 0; h <= state.horizonHours; h += step) {
      const x = xPos(h);
      svgHtml +=
        '<text x="' +
        x +
        '" y="' +
        (H - 8) +
        '" fill="#94a3b8" font-size="10" text-anchor="middle">+' +
        h +
        'h</text>';
    }

    document.getElementById('forecastSvg').innerHTML = svgHtml;

    const stockoutStr =
      pred.hoursToStockout === null
        ? '>' + state.horizonHours + 'h'
        : pred.hoursToStockout + 'h';
    document.getElementById('forecastMetrics').innerHTML =
      '<div class="metric-box"><span>On-Hand / Net</span><strong>' +
      pred.currentUnits +
      'u / ' +
      pred.effectiveNetUnits +
      'u</strong></div>' +
      '<div class="metric-box"><span>Burn / Inflow</span><strong>-' +
      pred.effectiveHourlyBurn +
      ' / +' +
      pred.hourlyReplenishment +
      '/h</strong></div>' +
      '<div class="metric-box"><span>Time to Stockout</span><strong class="' +
      (pred.hoursToStockout !== null ? 'text-danger' : 'text-stable') +
      '">' +
      stockoutStr +
      '</strong></div>' +
      '<div class="metric-box"><span>7d Trend</span><strong class="' +
      (pred.historicalMetrics.trendPercent > 10 ? 'text-amber' : 'text-cyan') +
      '">' +
      (pred.historicalMetrics.trendPercent >= 0 ? '+' : '') +
      pred.historicalMetrics.trendPercent +
      '%</strong></div>';

    document.getElementById('forecastFactors').innerHTML = pred.factors
      .map(function (f) {
        return '<li>' + escapeHtml(f) + '</li>';
      })
      .join('');
  }

  function renderConsumptionHistory() {
    const scopeNodeId =
      state.portalHospitalId !== 'ALL' ? state.portalHospitalId : 'ALL';
    const scopeBt =
      state.selectedBloodLens !== 'ALL' ? state.selectedBloodLens : 'ALL';
    const summary = Engine.summarizeConsumptionSeries(state.nodes, scopeNodeId, scopeBt);

    const scopeLabel =
      scopeNodeId === 'ALL' ? 'All Network Facilities' : findNode(scopeNodeId).name;
    const btLabel = scopeBt === 'ALL' ? 'All Blood Types' : scopeBt;

    document.getElementById('consumptionChartTitle').textContent =
      '7-Day Consumption History — ' + scopeLabel + ' (' + btLabel + ')';
    document.getElementById('consumptionChartSub').textContent =
      'Empirical daily transfusion demand driving predictive burn velocity';

    const W = 560;
    const H = 220;
    const pad = { top: 20, right: 18, bottom: 32, left: 42 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const maxVal = Math.max(
      10,
      Math.ceil(Math.max.apply(null, summary.dailyTotals) * 1.18)
    );

    let svg = '';
    [0, 0.5, 1].forEach(function (t) {
      const val = Math.round(t * maxVal);
      const y = pad.top + (1 - t) * plotH;
      svg +=
        '<line x1="' +
        pad.left +
        '" y1="' +
        y +
        '" x2="' +
        (W - pad.right) +
        '" y2="' +
        y +
        '" stroke="rgba(148,163,184,0.12)"/>';
      svg +=
        '<text x="' +
        (pad.left - 7) +
        '" y="' +
        (y + 3.5) +
        '" fill="#64748b" font-size="10" text-anchor="end">' +
        val +
        '</text>';
    });

    const slotW = plotW / summary.dailyTotals.length;
    const barW = Math.min(40, slotW * 0.58);
    const linePts = [];

    summary.dailyTotals.forEach(function (val, idx) {
      const cx = pad.left + slotW * (idx + 0.5);
      const barH = (val / maxVal) * plotH;
      const y = pad.top + plotH - barH;
      const isToday = idx === summary.dailyTotals.length - 1;
      linePts.push(cx.toFixed(1) + ',' + y.toFixed(1));

      svg +=
        '<rect x="' +
        (cx - barW / 2).toFixed(1) +
        '" y="' +
        y.toFixed(1) +
        '" width="' +
        barW.toFixed(1) +
        '" height="' +
        Math.max(1, barH).toFixed(1) +
        '" rx="4" fill="' +
        (isToday ? 'rgba(239, 68, 68, 0.72)' : 'rgba(6, 182, 212, 0.52)') +
        '" stroke="' +
        (isToday ? '#f87171' : '#22d3ee') +
        '" stroke-width="1"/>';
      svg +=
        '<text x="' +
        cx.toFixed(1) +
        '" y="' +
        (y - 5).toFixed(1) +
        '" fill="#e2e8f0" font-size="10" font-weight="700" text-anchor="middle">' +
        val +
        '</text>';
      svg +=
        '<text x="' +
        cx.toFixed(1) +
        '" y="' +
        (H - 10) +
        '" fill="#94a3b8" font-size="10" text-anchor="middle">' +
        escapeHtml(summary.labels[idx]) +
        '</text>';
    });

    svg +=
      '<polyline fill="none" stroke="#fbbf24" stroke-width="2" points="' +
      linePts.join(' ') +
      '"/>';

    document.getElementById('consumptionSvg').innerHTML = svg;

    document.getElementById('consumptionMetrics').innerHTML =
      '<div class="metric-box"><span>7-Day Total</span><strong>' +
      summary.total7d +
      ' u</strong></div>' +
      '<div class="metric-box"><span>Daily Average</span><strong>' +
      summary.avgDaily +
      ' u/d</strong></div>' +
      '<div class="metric-box"><span>Today Volume</span><strong>' +
      summary.todayTotal +
      ' u</strong></div>' +
      '<div class="metric-box"><span>Today vs 6d Avg</span><strong class="' +
      (summary.deltaPct > 8 ? 'text-danger' : 'text-stable') +
      '">' +
      (summary.deltaPct >= 0 ? '+' : '') +
      summary.deltaPct +
      '%</strong></div>';

    // Consumption Ledger Table
    const q = (state.consumptionSearchQuery || '').trim().toLowerCase();
    const events = state.consumptionEvents.filter(function (ev) {
      if (state.portalHospitalId !== 'ALL' && ev.hospitalId !== state.portalHospitalId) {
        return false;
      }
      if (state.selectedBloodLens !== 'ALL' && ev.bloodType !== state.selectedBloodLens) {
        return false;
      }
      if (!q) return true;
      return (
        [ev.hospitalName, ev.bloodType, ev.department, ev.category, ev.recordedBy, ev.id]
          .join(' ')
          .toLowerCase()
          .indexOf(q) !== -1
      );
    });

    const tbody = document.getElementById('consumptionTableBody');
    if (events.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;color:#98abc7;padding:18px;">No consumption events match the active hospital/blood filter.</td></tr>';
      return;
    }

    tbody.innerHTML = events
      .map(function (ev) {
        return (
          '<tr>' +
          '<td><strong>' +
          escapeHtml(ev.timestamp) +
          '</strong><span class="subline">' +
          escapeHtml(ev.id) +
          '</span></td>' +
          '<td><strong>' +
          escapeHtml(ev.hospitalName) +
          '</strong></td>' +
          '<td><span class="blood-chip-sm">' +
          escapeHtml(ev.bloodType) +
          '</span></td>' +
          '<td><strong>-' +
          ev.units +
          ' u</strong><span class="subline">After: ' +
          ev.stockAfter +
          'u</span></td>' +
          '<td><strong>' +
          escapeHtml(ev.department) +
          '</strong><span class="subline">' +
          escapeHtml(ev.category) +
          '</span></td>' +
          '<td>' +
          escapeHtml(ev.recordedBy) +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function renderInspector(matrix) {
    const node = findNode(state.selectedNodeId);
    const nodeReport = matrix.byNode[node.id];

    document.getElementById('inspectorTitle').textContent = node.name;
    document.getElementById('inspectorSubtitle').textContent =
      (node.hospitalTier || node.type) + ' • ' + node.zone + ' • ' + node.address;

    const bloodCellsHtml = Data.BLOOD_TYPES.map(function (bt) {
      const p = nodeReport.bloodPredictions[bt];
      const color = RISK_COLORS[p.riskLevel];
      return (
        '<button type="button" class="blood-mini-cell" data-inspect-bt="' +
        bt +
        '" style="border-color:' +
        color +
        '">' +
        '<strong style="color:' +
        color +
        '">' +
        bt +
        '</strong>' +
        '<span>' +
        p.currentUnits +
        'u • ' +
        (p.hoursToStockout !== null ? p.hoursToStockout + 'h' : 'OK') +
        '</span>' +
        '</button>'
      );
    }).join('');

    const c = node.contact;
    const contactPayload =
      node.name +
      ' | ' +
      c.name +
      ' (' +
      c.role +
      ') | Tel: ' +
      c.phone +
      ' | Email: ' +
      c.email +
      ' | Radio: ' +
      c.radio;

    document.getElementById('inspectorBody').innerHTML =
      '<div class="inspector-card">' +
      '<div class="inspector-row"><span><strong>24/7 Coordinator</strong></span><span>' +
      escapeHtml(c.name) +
      ' (' +
      escapeHtml(c.role) +
      ')</span></div>' +
      '<div class="inspector-row"><span><strong>Hotline Phone</strong></span><span>' +
      escapeHtml(c.phone) +
      '</span></div>' +
      '<div class="inspector-row"><span><strong>Dispatch Email</strong></span><span>' +
      escapeHtml(c.email) +
      '</span></div>' +
      '<div class="inspector-row"><span><strong>Radio / Pager</strong></span><span>' +
      escapeHtml(c.radio) +
      '</span></div>' +
      '<div class="contact-actions">' +
      '<a class="contact-link" href="tel:' +
      escapeHtml(c.phone) +
      '">Call Hotline</a>' +
      '<a class="contact-link" href="mailto:' +
      escapeHtml(c.email) +
      '?subject=' +
      encodeURIComponent('HemoPulse Emergency Blood Coordination — ' + node.name) +
      '">Email Dispatch</a>' +
      '<button type="button" class="btn btn-secondary btn-xs" id="btnCopyInspectorContact" data-copy="' +
      escapeHtml(contactPayload) +
      '">Copy Contact</button>' +
      '</div>' +
      '</div>' +
      '<div class="inspector-card">' +
      '<div style="font-size:11.5px;color:#98abc7;margin-bottom:7px;font-weight:600;">Local Inventory &amp; Predicted Stockout (Click to inspect curve)</div>' +
      '<div class="blood-mini-grid">' +
      bloodCellsHtml +
      '</div>' +
      '</div>';
  }

  function renderEmergenciesTable() {
    const tbody = document.getElementById('emergenciesTableBody');
    const scenario = getActiveScenario();
    const q = (state.searchQuery || '').trim().toLowerCase();

    const filtered = state.emergencies.filter(function (emg) {
      if (state.severityFilter !== 'all' && emg.severity !== state.severityFilter) return false;
      if (state.selectedBloodLens !== 'ALL' && emg.bloodType !== state.selectedBloodLens) return false;
      if (
        state.portalHospitalId !== 'ALL' &&
        emg.needLocation &&
        emg.needLocation.nodeId !== state.portalHospitalId
      ) {
        return false;
      }
      if (!q) return true;
      const haystack = [
        emg.id,
        emg.bloodType,
        emg.category,
        emg.component,
        emg.needLocation.facility,
        emg.needLocation.ward,
        emg.needLocation.zone,
        emg.needLocation.address,
        emg.contact.name,
        emg.contact.phone,
        emg.contact.email
      ]
        .join(' ')
        .toLowerCase();
      return haystack.indexOf(q) !== -1;
    });

    if (filtered.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;color:#98abc7;padding:20px;">No matching emergency blood needs for this workspace/filter. Use "+ Emergency Need" to report one.</td></tr>';
      return;
    }

    tbody.innerHTML = filtered
      .map(function (emg) {
        const sevMeta = Data.EMERGENCY_LEVELS[emg.severity] || Data.EMERGENCY_LEVELS.urgent;
        const routes = Engine.recommendDispatchRoutes(
          emg,
          state.nodes,
          state.emergencies,
          scenario,
          getActiveDemandPattern()
        );
        const topRoute = routes[0];
        const altRoute = routes[1];

        let dispatchHtml = '';
        if (emg.status === 'fulfilled') {
          dispatchHtml =
            '<div class="dispatch-box"><strong class="text-stable">FULFILLED</strong><span class="subline">' +
            escapeHtml(emg.fulfillmentSummary || 'Units dispatched and received.') +
            '</span></div>';
        } else if (topRoute) {
          dispatchHtml =
            '<div class="dispatch-box">' +
            '<strong>' +
            escapeHtml(topRoute.donorNodeName) +
            '</strong>' +
            '<span class="subline">Send <strong>' +
            topRoute.recommendedUnits +
            'u ' +
            escapeHtml(topRoute.donorBloodType) +
            '</strong> ' +
            (topRoute.isExactMatch ? '(Exact Match)' : '(Compatible Fallback)') +
            ' &bull; ETA ' +
            topRoute.etaMinutes +
            ' min (' +
            topRoute.distanceKm +
            ' km)</span>' +
            '<span class="subline">Contact: ' +
            escapeHtml(topRoute.donorContact.name) +
            ' (' +
            escapeHtml(topRoute.donorContact.phone) +
            ')</span>' +
            (altRoute
              ? '<span class="subline">Backup: ' +
                escapeHtml(altRoute.donorNodeName) +
                ' (' +
                altRoute.recommendedUnits +
                'u ' +
                escapeHtml(altRoute.donorBloodType) +
                ', ' +
                altRoute.etaMinutes +
                'm)</span>'
              : '') +
            '</div>';
        } else {
          dispatchHtml =
            '<div class="dispatch-box"><strong class="text-danger">Regional Donor Alert Required</strong><span class="subline">No hub or peer hospital holds surplus above safety buffer.</span></div>';
        }

        const actionsHtml =
          emg.status === 'active'
            ? '<div class="action-stack">' +
              (topRoute
                ? '<button type="button" class="btn btn-primary btn-xs" data-dispatch-id="' +
                  escapeHtml(emg.id) +
                  '">Dispatch ' +
                  topRoute.recommendedUnits +
                  'u</button>'
                : '') +
              '<button type="button" class="btn btn-secondary btn-xs" data-alert-id="' +
              escapeHtml(emg.id) +
              '">Broadcast Alert</button>' +
              '<button type="button" class="btn btn-ghost btn-xs" data-focus-emg="' +
              escapeHtml(emg.id) +
              '">Inspect Node</button>' +
              '</div>'
            : '<span class="risk-pill risk-stable">COMPLETED</span>';

        return (
          '<tr>' +
          '<td><span class="blood-badge">' +
          escapeHtml(emg.bloodType) +
          '</span><span class="subline"><strong>' +
          emg.unitsNeeded +
          ' units</strong></span><span class="subline">' +
          escapeHtml(emg.component || 'Packed RBC') +
          '</span></td>' +
          '<td><span class="risk-pill risk-' +
          escapeHtml(emg.severity) +
          '">' +
          escapeHtml(sevMeta.shortLabel) +
          '</span><strong style="display:block;margin-top:5px;">' +
          escapeHtml(emg.category) +
          '</strong><span class="subline">ID: ' +
          escapeHtml(emg.id) +
          ' &bull; SLA ' +
          sevMeta.slaMinutes +
          'm</span><span class="subline">' +
          escapeHtml(emg.notes || '') +
          '</span></td>' +
          '<td><strong>' +
          escapeHtml(emg.needLocation.facility) +
          '</strong><span class="subline">' +
          escapeHtml(emg.needLocation.ward) +
          '</span><span class="subline">' +
          escapeHtml(emg.needLocation.zone + ' — ' + emg.needLocation.address) +
          '</span></td>' +
          '<td><strong>' +
          escapeHtml(emg.contact.name) +
          '</strong><span class="subline">' +
          escapeHtml(emg.contact.role || 'Coordinator') +
          '</span><span class="subline"><a style="color:#67e8f9" href="tel:' +
          escapeHtml(emg.contact.phone) +
          '">' +
          escapeHtml(emg.contact.phone) +
          '</a></span><span class="subline"><a style="color:#98abc7" href="mailto:' +
          escapeHtml(emg.contact.email) +
          '">' +
          escapeHtml(emg.contact.email) +
          '</a></span><span class="subline">Radio: ' +
          escapeHtml(emg.contact.radio || 'CH-01') +
          '</span></td>' +
          '<td>' +
          dispatchHtml +
          '</td>' +
          '<td>' +
          actionsHtml +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function renderRiskMatrix(matrix) {
    const table = document.getElementById('riskMatrixTable');
    let html = '<thead><tr><th>Hospital / Hub</th>';
    Data.BLOOD_TYPES.forEach(function (bt) {
      html += '<th>' + bt + '</th>';
    });
    html += '</tr></thead><tbody>';

    state.nodes.forEach(function (node) {
      html +=
        '<tr><td class="node-col">' +
        escapeHtml(node.name) +
        '<span class="subline">' +
        escapeHtml(node.zone) +
        '</span></td>';
      Data.BLOOD_TYPES.forEach(function (bt) {
        const p = matrix.byNode[node.id].bloodPredictions[bt];
        const isSelected =
          state.selectedNodeId === node.id &&
          (state.selectedBloodLens !== 'ALL' ? state.selectedBloodLens : state.selectedBloodType) === bt;
        const stockoutText = p.hoursToStockout !== null ? p.hoursToStockout + 'h' : 'OK';
        html +=
          '<td class="matrix-cell cell-' +
          p.riskLevel +
          (isSelected ? ' selected-cell' : '') +
          '" data-matrix-node="' +
          escapeHtml(node.id) +
          '" data-matrix-bt="' +
          bt +
          '">' +
          '<strong>' +
          p.currentUnits +
          'u</strong><span class="subline">' +
          stockoutText +
          ' (' +
          p.riskScore +
          ')</span></td>';
      });
      html += '</tr>';
    });
    html += '</tbody>';
    table.innerHTML = html;
  }

  function renderLogs() {
    const list = document.getElementById('activityLog');
    list.innerHTML = state.logs
      .map(function (entry) {
        const cls =
          entry.level === 'critical'
            ? 'log-critical'
            : entry.level === 'success'
            ? 'log-success'
            : '';
        return (
          '<li class="' +
          cls +
          '"><span class="log-time">' +
          escapeHtml(entry.time) +
          '</span>' +
          escapeHtml(entry.text) +
          '</li>'
        );
      })
      .join('');
  }

  function renderEmergencyDemandPatterns() {
    const allPatterns = getAllDemandPatterns();
    const activePattern = getActiveDemandPattern();
    const scenario = getActiveScenario();
    const scopeNodeId = state.portalHospitalId !== 'ALL' ? state.portalHospitalId : 'ALL';
    const scopeBt = state.selectedBloodLens !== 'ALL' ? state.selectedBloodLens : 'ALL';

    const analyses = Engine.analyzeEmergencyDemandPatterns(
      allPatterns,
      state.nodes,
      state.emergencies,
      scenario,
      state.horizonHours,
      scopeNodeId,
      scopeBt
    );

    const grid = document.getElementById('patternCardsGrid');
    grid.innerHTML = analyses
      .map(function (item) {
        const pat = item.pattern;
        const isActive = pat.id === activePattern.id;
        const topBlood = Object.keys(pat.bloodTypeWeights || {})
          .filter(function (bt) {
            return pat.bloodTypeWeights[bt] >= 1.5;
          })
          .join(', ');

        return (
          '<article class="pattern-card' +
          (isActive ? ' active-pattern' : '') +
          '" data-pattern-id="' +
          escapeHtml(pat.id) +
          '">' +
          '<div class="pattern-card-head">' +
          '<div><h3>' +
          escapeHtml(pat.name) +
          '</h3><span class="subline">' +
          escapeHtml(pat.category + ' • ' + pat.peakWindowLabel) +
          '</span></div>' +
          '<span class="risk-pill ' +
          (item.criticalAlerts >= 8 ? 'risk-critical' : item.criticalAlerts >= 5 ? 'risk-high' : 'risk-watch') +
          '">' +
          item.criticalAlerts +
          ' crit</span>' +
          '</div>' +
          '<div style="font-size:11.5px;color:#98abc7;">' +
          escapeHtml(pat.description) +
          '</div>' +
          '<div class="pattern-tags">' +
          '<span class="pattern-tag">Peak &times;' +
          Number(pat.peakMultiplier || 1).toFixed(1) +
          '</span>' +
          '<span class="pattern-tag">' +
          item.totalProjectedDemand +
          'u demand</span>' +
          (topBlood ? '<span class="pattern-tag">Stresses: ' + escapeHtml(topBlood) + '</span>' : '') +
          '</div>' +
          '</article>'
        );
      })
      .join('');

    let activeAnalysis = analyses[0];
    let baselineAnalysis = analyses[0];
    analyses.forEach(function (a) {
      if (a.pattern.id === activePattern.id) activeAnalysis = a;
      if (a.pattern.id === 'steady_baseline') baselineAnalysis = a;
    });

    const scopeLabel =
      scopeNodeId === 'ALL' ? 'All Hospitals' : findNode(scopeNodeId).name;
    document.getElementById('patternCurveTitle').textContent =
      activePattern.name + ' (' + scopeLabel + ')';
    document.getElementById('patternCurveSub').textContent =
      'Projected hourly blood demand (units/hr) vs. Steady Clinical Baseline over ' +
      Math.min(48, Math.max(12, state.horizonHours)) +
      'h';
    document.getElementById('patternPeakBadge').textContent =
      'PEAK ' + activeAnalysis.peakUnitsPerHour + ' u/hr @ +' + activeAnalysis.peakHour + 'h';
    document.getElementById('patternPeakBadge').className =
      'risk-pill ' +
      (activeAnalysis.pattern.id === 'steady_baseline' ? 'risk-stable' : 'risk-critical');

    // Render Pattern Wave SVG Chart
    const W = 560;
    const H = 220;
    const pad = { top: 20, right: 18, bottom: 30, left: 42 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const activeCurve = activeAnalysis.hourlyDemandCurve;
    const baseCurve = baselineAnalysis.hourlyDemandCurve;
    const maxHr = Math.max(1, activeCurve.length - 1);

    let maxY = 2;
    activeCurve.forEach(function (pt) {
      if (pt.unitsPerHour > maxY) maxY = pt.unitsPerHour;
    });
    baseCurve.forEach(function (pt) {
      if (pt.unitsPerHour > maxY) maxY = pt.unitsPerHour;
    });
    maxY = Math.ceil(maxY * 1.18 * 10) / 10;

    function xPos(hr) {
      return pad.left + (hr / maxHr) * plotW;
    }
    function yPos(val) {
      return pad.top + (1 - val / maxY) * plotH;
    }

    let svg = '';
    [0, 0.5, 1].forEach(function (t) {
      const val = Math.round(t * maxY * 10) / 10;
      const y = yPos(val);
      svg +=
        '<line x1="' +
        pad.left +
        '" y1="' +
        y +
        '" x2="' +
        (W - pad.right) +
        '" y2="' +
        y +
        '" stroke="rgba(148,163,184,0.12)"/>';
      svg +=
        '<text x="' +
        (pad.left - 7) +
        '" y="' +
        (y + 3.5) +
        '" fill="#64748b" font-size="10" text-anchor="end">' +
        val +
        '</text>';
    });

    const basePath = baseCurve
      .map(function (pt, idx) {
        return (idx === 0 ? 'M ' : 'L ') + xPos(pt.hour).toFixed(1) + ' ' + yPos(pt.unitsPerHour).toFixed(1);
      })
      .join(' ');
    svg +=
      '<path d="' +
      basePath +
      '" fill="none" stroke="#64748b" stroke-width="1.8" stroke-dasharray="5 4"/>';

    const areaPts = activeCurve.map(function (pt) {
      return xPos(pt.hour).toFixed(1) + ',' + yPos(pt.unitsPerHour).toFixed(1);
    });
    areaPts.push(xPos(maxHr).toFixed(1) + ',' + (pad.top + plotH).toFixed(1));
    areaPts.push(xPos(0).toFixed(1) + ',' + (pad.top + plotH).toFixed(1));
    svg += '<polygon points="' + areaPts.join(' ') + '" fill="rgba(245, 158, 11, 0.17)"/>';

    const activePath = activeCurve
      .map(function (pt, idx) {
        return (idx === 0 ? 'M ' : 'L ') + xPos(pt.hour).toFixed(1) + ' ' + yPos(pt.unitsPerHour).toFixed(1);
      })
      .join(' ');
    svg +=
      '<path d="' +
      activePath +
      '" fill="none" stroke="#f59e0b" stroke-width="2.6" stroke-linecap="round"/>';

    for (let h = 0; h <= maxHr; h += 12) {
      svg +=
        '<text x="' +
        xPos(h).toFixed(1) +
        '" y="' +
        (H - 9) +
        '" fill="#94a3b8" font-size="10" text-anchor="middle">+' +
        h +
        'h</text>';
    }

    document.getElementById('patternCurveSvg').innerHTML = svg;

    const surgeDelta =
      baselineAnalysis.totalProjectedDemand > 0
        ? Math.round(
            ((activeAnalysis.totalProjectedDemand - baselineAnalysis.totalProjectedDemand) /
              baselineAnalysis.totalProjectedDemand) *
              100
          )
        : 0;

    document.getElementById('patternMetrics').innerHTML =
      '<div class="metric-box"><span>Projected Demand</span><strong>' +
      activeAnalysis.totalProjectedDemand +
      ' u</strong></div>' +
      '<div class="metric-box"><span>vs Baseline</span><strong class="' +
      (surgeDelta > 10 ? 'text-danger' : 'text-cyan') +
      '">' +
      (surgeDelta >= 0 ? '+' : '') +
      surgeDelta +
      '%</strong></div>' +
      '<div class="metric-box"><span>Critical Pairs</span><strong class="text-amber">' +
      activeAnalysis.criticalAlerts +
      '</strong></div>' +
      '<div class="metric-box"><span>Predicted Deficit</span><strong>' +
      activeAnalysis.predictedDeficit +
      ' u</strong></div>';
  }

  function renderBloodBalanceChart(matrix) {
    const svg = document.getElementById('bloodBalanceSvg');
    if (!svg) return;

    const scopeNodes =
      state.portalHospitalId !== 'ALL'
        ? [findNode(state.portalHospitalId)]
        : state.nodes;
    const scopeLabel =
      state.portalHospitalId !== 'ALL' ? scopeNodes[0].name : 'All Network Facilities';
    document.getElementById('bloodBalanceSub').textContent =
      scopeLabel + ' — On-hand reserve vs. ' + state.horizonHours + 'h projected demand';

    const items = Data.BLOOD_TYPES.map(function (bt) {
      let stock = 0;
      let demand = 0;
      for (let i = 0; i < scopeNodes.length; i++) {
        const p = matrix.byNode[scopeNodes[i].id].bloodPredictions[bt];
        stock += p.currentUnits;
        demand += p.effectiveHourlyBurn * state.horizonHours + p.shockUnits;
      }
      return {
        bt: bt,
        stock: Math.round(stock),
        demand: Math.round(demand)
      };
    });

    const W = 520;
    const H = 245;
    const pad = { top: 24, right: 14, bottom: 32, left: 38 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    let maxVal = 20;
    items.forEach(function (it) {
      if (it.stock > maxVal) maxVal = it.stock;
      if (it.demand > maxVal) maxVal = it.demand;
    });
    maxVal = Math.ceil(maxVal * 1.18);

    let html = '';
    [0, 0.5, 1].forEach(function (t) {
      const val = Math.round(t * maxVal);
      const y = pad.top + (1 - t) * plotH;
      html +=
        '<line x1="' +
        pad.left +
        '" y1="' +
        y +
        '" x2="' +
        (W - pad.right) +
        '" y2="' +
        y +
        '" stroke="rgba(148,163,184,0.12)"/>';
      html +=
        '<text x="' +
        (pad.left - 6) +
        '" y="' +
        (y + 3.5) +
        '" fill="#64748b" font-size="10" text-anchor="end">' +
        val +
        '</text>';
    });

    const slotW = plotW / items.length;
    const barW = Math.min(18, slotW * 0.34);
    const activeBt =
      state.selectedBloodLens !== 'ALL' ? state.selectedBloodLens : state.selectedBloodType;

    items.forEach(function (it, idx) {
      const cx = pad.left + slotW * (idx + 0.5);
      const hStock = (it.stock / maxVal) * plotH;
      const hDem = (it.demand / maxVal) * plotH;
      const yStock = pad.top + plotH - hStock;
      const yDem = pad.top + plotH - hDem;
      const diff = it.stock - it.demand;
      const isFocused = it.bt === activeBt;

      html += '<g class="viz-interactive" data-viz-bt="' + it.bt + '">';
      if (isFocused) {
        html +=
          '<rect x="' +
          (cx - slotW * 0.44).toFixed(1) +
          '" y="' +
          (pad.top - 4) +
          '" width="' +
          (slotW * 0.88).toFixed(1) +
          '" height="' +
          (plotH + 26) +
          '" rx="6" fill="rgba(6, 182, 212, 0.08)" stroke="rgba(6, 182, 212, 0.35)" stroke-width="1"/>';
      }
      html +=
        '<rect x="' +
        (cx - barW - 1.5).toFixed(1) +
        '" y="' +
        yStock.toFixed(1) +
        '" width="' +
        barW +
        '" height="' +
        Math.max(2, hStock).toFixed(1) +
        '" rx="3" fill="#22d3ee"/>';
      html +=
        '<rect x="' +
        (cx + 1.5).toFixed(1) +
        '" y="' +
        yDem.toFixed(1) +
        '" width="' +
        barW +
        '" height="' +
        Math.max(2, hDem).toFixed(1) +
        '" rx="3" fill="' +
        (diff < 0 ? '#ef4444' : '#f97316') +
        '"/>';
      html +=
        '<text x="' +
        cx.toFixed(1) +
        '" y="' +
        (Math.min(yStock, yDem) - 5).toFixed(1) +
        '" fill="' +
        (diff < 0 ? '#fca5a5' : '#6ee7b7') +
        '" font-size="9.5" font-weight="700" text-anchor="middle">' +
        (diff >= 0 ? '+' : '') +
        diff +
        'u</text>';
      html +=
        '<text x="' +
        cx.toFixed(1) +
        '" y="' +
        (H - 10) +
        '" fill="' +
        (isFocused ? '#67e8f9' : '#cbd5e1') +
        '" font-size="11" font-weight="700" text-anchor="middle">' +
        it.bt +
        '</text>';
      html += '</g>';
    });

    svg.innerHTML = html;
  }

  function renderHospitalComparisonChart(matrix) {
    const svg = document.getElementById('hospitalCompareSvg');
    if (!svg) return;

    const rows = state.nodes
      .map(function (node) {
        const rep = matrix.byNode[node.id];
        let emgUnits = 0;
        state.emergencies.forEach(function (e) {
          if (e.status === 'active' && e.needLocation && e.needLocation.nodeId === node.id) {
            emgUnits += Number(e.unitsNeeded || 0);
          }
        });
        return {
          id: node.id,
          shortName: node.name.replace(' Hospital', '').replace(' Medical Center', '').slice(0, 22),
          stock: rep.totalNodeUnits,
          emgUnits: emgUnits,
          riskScore: rep.maxRiskScore,
          riskLevel: rep.worstRiskLevel
        };
      })
      .sort(function (a, b) {
        return b.riskScore - a.riskScore;
      });

    const W = 520;
    const H = 245;
    const pad = { top: 14, right: 64, bottom: 14, left: 152 };
    const plotW = W - pad.left - pad.right;
    const rowH = (H - pad.top - pad.bottom) / Math.max(1, rows.length);

    let maxVal = 40;
    rows.forEach(function (r) {
      if (r.stock + r.emgUnits > maxVal) maxVal = r.stock + r.emgUnits;
    });

    let html = '';
    rows.forEach(function (r, idx) {
      const y = pad.top + idx * rowH + 4;
      const barH = Math.max(10, rowH - 10);
      const stockW = (r.stock / maxVal) * plotW;
      const emgW = (r.emgUnits / maxVal) * plotW;
      const color = RISK_COLORS[r.riskLevel] || RISK_COLORS.stable;
      const isActivePortal = state.portalHospitalId === r.id;

      html += '<g class="viz-interactive" data-viz-hosp="' + escapeHtml(r.id) + '">';
      html +=
        '<text x="' +
        (pad.left - 8) +
        '" y="' +
        (y + barH * 0.72).toFixed(1) +
        '" fill="' +
        (isActivePortal ? '#22d3ee' : '#cbd5e1') +
        '" font-size="10.5" font-weight="' +
        (isActivePortal ? '700' : '600') +
        '" text-anchor="end">' +
        escapeHtml(r.shortName) +
        '</text>';
      html +=
        '<rect x="' +
        pad.left +
        '" y="' +
        y.toFixed(1) +
        '" width="' +
        plotW +
        '" height="' +
        barH.toFixed(1) +
        '" rx="4" fill="rgba(15, 25, 40, 0.9)" stroke="rgba(35,55,84,0.6)"/>';
      html +=
        '<rect x="' +
        pad.left +
        '" y="' +
        y.toFixed(1) +
        '" width="' +
        Math.max(2, stockW).toFixed(1) +
        '" height="' +
        barH.toFixed(1) +
        '" rx="4" fill="#10b981"/>';
      if (r.emgUnits > 0) {
        html +=
          '<rect x="' +
          (pad.left + stockW).toFixed(1) +
          '" y="' +
          y.toFixed(1) +
          '" width="' +
          Math.max(4, emgW).toFixed(1) +
          '" height="' +
          barH.toFixed(1) +
          '" rx="3" fill="#ef4444"/>';
      }
      html +=
        '<text x="' +
        (W - 8) +
        '" y="' +
        (y + barH * 0.72).toFixed(1) +
        '" fill="' +
        color +
        '" font-size="10.5" font-weight="700" text-anchor="end">' +
        r.stock +
        'u • R' +
        r.riskScore +
        '</text>';
      html += '</g>';
    });

    svg.innerHTML = html;
  }

  function renderCompatibilityFlowChart(matrix) {
    const svg = document.getElementById('compatFlowSvg');
    if (!svg) return;

    const targetBt =
      state.selectedBloodLens !== 'ALL' ? state.selectedBloodLens : state.selectedBloodType;
    const compatibleDonors = Engine.getCompatibleDonorTypes(targetBt);
    document.getElementById('compatFlowSub').textContent =
      'Highlighting safe RBC donors for ' + targetBt + ' (' + compatibleDonors.join(', ') + ')';

    const summaryByBt = {};
    matrix.bloodTypeSummary.forEach(function (s) {
      summaryByBt[s.bloodType] = s;
    });

    const W = 520;
    const H = 245;
    const leftX = 112;
    const rightX = 408;
    const topPad = 24;
    const stepY = (H - 42) / (Data.BLOOD_TYPES.length - 1);

    let html =
      '<text x="72" y="14" fill="#94a3b8" font-size="10" font-weight="700" text-anchor="middle">DONOR SUPPLY</text>' +
      '<text x="448" y="14" fill="#94a3b8" font-size="10" font-weight="700" text-anchor="middle">RECIPIENT</text>';

    // Draw all compatibility edges faintly first, then focused ones bright
    Data.BLOOD_TYPES.forEach(function (recBt, rIdx) {
      const donors = Engine.getCompatibleDonorTypes(recBt);
      const ry = topPad + rIdx * stepY;
      donors.forEach(function (donBt) {
        const dIdx = Data.BLOOD_TYPES.indexOf(donBt);
        const dy = topPad + dIdx * stepY;
        const isHighlighted = recBt === targetBt;
        const isExact = isHighlighted && donBt === recBt;
        html +=
          '<path d="M ' +
          leftX +
          ' ' +
          dy.toFixed(1) +
          ' C ' +
          (leftX + 115) +
          ' ' +
          dy.toFixed(1) +
          ' ' +
          (rightX - 115) +
          ' ' +
          ry.toFixed(1) +
          ' ' +
          rightX +
          ' ' +
          ry.toFixed(1) +
          '" fill="none" stroke="' +
          (isExact ? '#ef4444' : isHighlighted ? '#22d3ee' : 'rgba(148,163,184,0.11)') +
          '" stroke-width="' +
          (isExact ? '2.8' : isHighlighted ? '2.0' : '1') +
          '"/>';
      });
    });

    // Left Donor Nodes & Right Recipient Nodes
    Data.BLOOD_TYPES.forEach(function (bt, idx) {
      const y = topPad + idx * stepY;
      const info = summaryByBt[bt];
      const isCompatDonor = compatibleDonors.indexOf(bt) !== -1;
      const isRecipient = bt === targetBt;

      // Donor pill
      html +=
        '<g class="viz-interactive" data-viz-compat-bt="' +
        bt +
        '">' +
        '<rect x="18" y="' +
        (y - 10).toFixed(1) +
        '" width="94" height="20" rx="6" fill="' +
        (isCompatDonor ? 'rgba(6, 182, 212, 0.22)' : '#0f1928') +
        '" stroke="' +
        (isCompatDonor ? '#22d3ee' : '#233754') +
        '"/>' +
        '<text x="38" y="' +
        (y + 3.5).toFixed(1) +
        '" fill="#f8fafc" font-size="10.5" font-weight="700" text-anchor="middle">' +
        bt +
        '</text>' +
        '<text x="103" y="' +
        (y + 3.5).toFixed(1) +
        '" fill="#94a3b8" font-size="9.5" text-anchor="end">' +
        info.totalUnits +
        'u</text>';

      // Recipient pill
      html +=
        '<rect x="408" y="' +
        (y - 10).toFixed(1) +
        '" width="94" height="20" rx="6" fill="' +
        (isRecipient ? 'rgba(239, 68, 68, 0.24)' : '#0f1928') +
        '" stroke="' +
        (isRecipient ? '#ef4444' : '#233754') +
        '"/>' +
        '<text x="430" y="' +
        (y + 3.5).toFixed(1) +
        '" fill="#f8fafc" font-size="10.5" font-weight="700" text-anchor="middle">' +
        bt +
        '</text>' +
        '<text x="494" y="' +
        (y + 3.5).toFixed(1) +
        '" fill="' +
        (info.atRiskNodes > 0 ? '#fca5a5' : '#6ee7b7') +
        '" font-size="9.5" text-anchor="end">' +
        (info.atRiskNodes > 0 ? info.atRiskNodes + ' risk' : 'safe') +
        '</text>' +
        '</g>';
    });

    svg.innerHTML = html;
  }

  function renderVisualAnalytics(matrix) {
    renderBloodBalanceChart(matrix);
    renderHospitalComparisonChart(matrix);
    renderCompatibilityFlowChart(matrix);
  }

  function renderAll() {
    const scenario = getActiveScenario();
    const pattern = getActiveDemandPattern();
    lastMatrix = Engine.predictNetworkMatrix(
      state.nodes,
      state.emergencies,
      scenario,
      state.horizonHours,
      pattern
    );

    renderHeaderControls();
    renderKPIs(lastMatrix);
    renderHospitalDirectory(lastMatrix);
    renderBloodTypeBar(lastMatrix);
    renderNetworkMap(lastMatrix);
    renderForecastChart(lastMatrix);
    renderInspector(lastMatrix);
    renderConsumptionHistory();
    renderEmergencyDemandPatterns();
    renderVisualAnalytics(lastMatrix);
    renderEmergenciesTable();
    renderRiskMatrix(lastMatrix);
    renderLogs();
    saveState();
  }

  function selectPortal(nodeId) {
    state.portalHospitalId = nodeId;
    if (nodeId !== 'ALL') {
      state.selectedNodeId = nodeId;
    }
    renderAll();
  }

  function dispatchEmergency(emgId) {
    const emg = findEmergency(emgId);
    if (!emg || emg.status !== 'active') return;
    const scenario = getActiveScenario();
    const routes = Engine.recommendDispatchRoutes(
      emg,
      state.nodes,
      state.emergencies,
      scenario,
      getActiveDemandPattern()
    );
    if (routes.length === 0) {
      showToast('No hub or hospital has surplus above safety reserve.');
      return;
    }

    const best = routes[0];
    const donorNode = findNode(best.donorNodeId);
    const unitsSent = best.recommendedUnits;

    donorNode.inventory[best.donorBloodType] = Math.max(
      0,
      Number(donorNode.inventory[best.donorBloodType] || 0) - unitsSent
    );

    if (emg.needLocation && emg.needLocation.nodeId) {
      const destNode = findNode(emg.needLocation.nodeId);
      if (destNode) {
        destNode.inventory[best.donorBloodType] =
          Number(destNode.inventory[best.donorBloodType] || 0) + unitsSent;
      }
    }

    if (unitsSent >= emg.unitsNeeded) {
      emg.status = 'fulfilled';
      emg.fulfillmentSummary =
        unitsSent +
        'u ' +
        best.donorBloodType +
        ' dispatched from ' +
        best.donorNodeName +
        ' (ETA ' +
        best.etaMinutes +
        'm)';
    } else {
      emg.unitsNeeded -= unitsSent;
    }

    addLog(
      'Dispatched ' +
        unitsSent +
        'u ' +
        best.donorBloodType +
        ' from ' +
        best.donorNodeName +
        ' to ' +
        emg.needLocation.facility +
        ' (Contact: ' +
        emg.contact.name +
        ', ' +
        emg.contact.phone +
        ').',
      'success'
    );
    showToast('Dispatched ' + unitsSent + 'u ' + best.donorBloodType + ' (' + best.etaMinutes + ' min ETA)');
    renderAll();
  }

  function broadcastDonorAlert(emgId) {
    const emg = findEmergency(emgId);
    if (!emg) return;
    addLog(
      'Donor alert broadcasted for ' +
        emg.unitsNeeded +
        'u ' +
        emg.bloodType +
        ' at ' +
        emg.needLocation.facility +
        ' (' +
        emg.needLocation.zone +
        ') — Contact: ' +
        emg.contact.phone,
      'critical'
    );
    showToast('Emergency donor broadcast sent for ' + emg.bloodType + ' at ' + emg.needLocation.facility);
    renderAll();
  }

  function populateEmergencyModal() {
    const btSelect = document.getElementById('formBloodType');
    btSelect.innerHTML = Data.BLOOD_TYPES.map(function (bt) {
      return '<option value="' + bt + '">' + bt + '</option>';
    }).join('');

    const facSelect = document.getElementById('formFacilitySelect');
    facSelect.innerHTML =
      state.nodes
        .map(function (n) {
          return (
            '<option value="' +
            escapeHtml(n.id) +
            '">' +
            escapeHtml(n.name + ' (' + n.zone + ')') +
            '</option>'
          );
        })
        .join('') + '<option value="CUSTOM">+ Custom Incident / Field Location</option>';

    if (state.portalHospitalId !== 'ALL') {
      facSelect.value = state.portalHospitalId;
    }
    syncFacilityFields();
  }

  function syncFacilityFields() {
    const facId = document.getElementById('formFacilitySelect').value;
    const customGroup = document.getElementById('customLocationGroup');
    if (facId === 'CUSTOM') {
      customGroup.classList.remove('hidden');
      document.getElementById('formCustomFacility').required = true;
      document.getElementById('formAddress').value = '';
      document.getElementById('formZone').value = 'Metro Perimeter';
      return;
    }

    customGroup.classList.add('hidden');
    document.getElementById('formCustomFacility').required = false;
    const node = findNode(facId);
    if (node) {
      document.getElementById('formZone').value = node.zone;
      document.getElementById('formAddress').value = node.address;
      document.getElementById('formContactName').value = node.contact.name;
      document.getElementById('formContactRole').value = node.contact.role;
      document.getElementById('formContactPhone').value = node.contact.phone;
      document.getElementById('formContactEmail').value = node.contact.email;
      document.getElementById('formContactRadio').value = node.contact.radio;
    }
  }

  function populateConsumptionModal() {
    const hospSel = document.getElementById('consHospitalSelect');
    hospSel.innerHTML = state.nodes
      .map(function (n) {
        return '<option value="' + escapeHtml(n.id) + '">' + escapeHtml(n.name) + '</option>';
      })
      .join('');
    hospSel.value =
      state.portalHospitalId !== 'ALL' ? state.portalHospitalId : state.selectedNodeId;

    const btSel = document.getElementById('consBloodType');
    btSel.innerHTML = Data.BLOOD_TYPES.map(function (bt) {
      return '<option value="' + bt + '">' + bt + '</option>';
    }).join('');
    btSel.value =
      state.selectedBloodLens !== 'ALL' ? state.selectedBloodLens : state.selectedBloodType;
  }

  function exportJsonReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      workspaceHospital: state.portalHospitalId,
      demandPattern: getActiveDemandPattern(),
      scenario: getActiveScenario(),
      horizonHours: state.horizonHours,
      kpis: lastMatrix ? lastMatrix.kpis : null,
      hospitals: state.nodes.map(function (n) {
        return {
          id: n.id,
          name: n.name,
          tier: n.hospitalTier,
          zone: n.zone,
          contact: n.contact,
          inventory: n.inventory,
          dailyConsumptionHistory: n.dailyConsumptionHistory
        };
      }),
      consumptionEvents: state.consumptionEvents,
      activeEmergencies: state.emergencies
    };

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hemopulse-multi-hospital-report.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Exported multi-hospital prediction & consumption report (JSON).');
  }

  function bindEvents() {
    document.getElementById('portalSelect').addEventListener('change', function (e) {
      selectPortal(e.target.value);
    });

    document.getElementById('btnViewAllHospitals').addEventListener('click', function () {
      selectPortal('ALL');
    });

    document.getElementById('hospitalCardsGrid').addEventListener('click', function (e) {
      const btn = e.target.closest('[data-portal-btn]');
      const card = e.target.closest('[data-portal-node]');
      const targetId = btn
        ? btn.getAttribute('data-portal-btn')
        : card
        ? card.getAttribute('data-portal-node')
        : null;
      if (!targetId) return;
      if (state.portalHospitalId === targetId && btn) {
        selectPortal('ALL');
      } else {
        selectPortal(targetId);
      }
    });

    document.getElementById('scenarioSelect').addEventListener('change', function (e) {
      state.scenarioId = e.target.value;
      addLog('Switched predictive simulation scenario to: ' + getActiveScenario().name, 'info');
      renderAll();
    });

    function setDemandPattern(patternId) {
      state.demandPatternId = patternId;
      const pat = getActiveDemandPattern();
      addLog('Applied emergency demand pattern: ' + pat.name + ' (' + pat.peakWindowLabel + ').', 'info');
      showToast('Applied demand pattern: ' + pat.name);
      renderAll();
    }

    document.getElementById('patternSelect').addEventListener('change', function (e) {
      setDemandPattern(e.target.value);
    });

    document.getElementById('patternCardsGrid').addEventListener('click', function (e) {
      const card = e.target.closest('[data-pattern-id]');
      if (!card) return;
      setDemandPattern(card.getAttribute('data-pattern-id'));
    });

    document.getElementById('btnCustomPattern').addEventListener('click', function () {
      document.getElementById('patternModal').classList.remove('hidden');
    });
    document.getElementById('btnClosePatternModal').addEventListener('click', function () {
      document.getElementById('patternModal').classList.add('hidden');
    });
    document.getElementById('btnCancelPatternModal').addEventListener('click', function () {
      document.getElementById('patternModal').classList.add('hidden');
    });

    document.getElementById('patternForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const name = document.getElementById('patName').value.trim();
      const category = document.getElementById('patCategory').value.trim();
      const waveShape = document.getElementById('patWaveShape').value;
      const targetTier = document.getElementById('patTargetTier').value;
      const primaryBt = document.getElementById('patPrimaryBt').value;
      const peakMult = Math.max(1.1, Number(document.getElementById('patPeakMult').value) || 2.0);
      const description = document.getElementById('patDescription').value.trim();

      const weights = {};
      Data.BLOOD_TYPES.forEach(function (bt) {
        weights[bt] = bt === primaryBt ? peakMult : bt === 'O-' ? Math.max(1.2, round2Local(peakMult * 0.7)) : 1.1;
      });
      function round2Local(v) {
        return Math.round(v * 100) / 100;
      }

      const customId = 'custom_' + Date.now();
      const tierAffinity = {};
      tierAffinity[targetTier] = 1.3;

      if (!state.customPatterns) state.customPatterns = {};
      state.customPatterns[customId] = {
        id: customId,
        name: name,
        category: category,
        waveShape: waveShape,
        description: description,
        peakWindowLabel: 'Peak x' + peakMult.toFixed(1) + ' (' + primaryBt + ')',
        peakMultiplier: peakMult,
        targetTiers: [targetTier],
        bloodTypeWeights: weights,
        tierAffinity: tierAffinity
      };

      document.getElementById('patternModal').classList.add('hidden');
      document.getElementById('patternForm').reset();
      setDemandPattern(customId);
    });

    document.getElementById('horizonSelect').addEventListener('change', function (e) {
      state.horizonHours = Number(e.target.value) || 48;
      renderAll();
    });

    document.getElementById('bloodTypePills').addEventListener('click', function (e) {
      const btn = e.target.closest('[data-lens]');
      if (!btn) return;
      state.selectedBloodLens = btn.getAttribute('data-lens');
      if (state.selectedBloodLens !== 'ALL') {
        state.selectedBloodType = state.selectedBloodLens;
      }
      renderAll();
    });

    document.getElementById('bloodBalanceSvg').addEventListener('click', function (e) {
      const g = e.target.closest('[data-viz-bt]');
      if (!g) return;
      const bt = g.getAttribute('data-viz-bt');
      state.selectedBloodType = bt;
      state.selectedBloodLens = state.selectedBloodLens === bt ? 'ALL' : bt;
      renderAll();
    });

    document.getElementById('hospitalCompareSvg').addEventListener('click', function (e) {
      const g = e.target.closest('[data-viz-hosp]');
      if (!g) return;
      selectPortal(g.getAttribute('data-viz-hosp'));
    });

    document.getElementById('compatFlowSvg').addEventListener('click', function (e) {
      const g = e.target.closest('[data-viz-compat-bt]');
      if (!g) return;
      const bt = g.getAttribute('data-viz-compat-bt');
      state.selectedBloodType = bt;
      state.selectedBloodLens = bt;
      renderAll();
    });

    document.getElementById('networkSvg').addEventListener('click', function (e) {
      const nodeEl = e.target.closest('[data-node-id]');
      if (nodeEl) {
        state.selectedNodeId = nodeEl.getAttribute('data-node-id');
        const bt = nodeEl.getAttribute('data-bt');
        if (bt) state.selectedBloodType = bt;
        renderAll();
        return;
      }
      const emgEl = e.target.closest('[data-emg-id]');
      if (emgEl) {
        const emg = findEmergency(emgEl.getAttribute('data-emg-id'));
        if (emg) {
          if (emg.needLocation && emg.needLocation.nodeId) {
            state.selectedNodeId = emg.needLocation.nodeId;
          }
          state.selectedBloodType = emg.bloodType;
          state.selectedBloodLens = emg.bloodType;
          renderAll();
        }
      }
    });

    document.getElementById('inspectorBody').addEventListener('click', function (e) {
      const btBtn = e.target.closest('[data-inspect-bt]');
      if (btBtn) {
        state.selectedBloodType = btBtn.getAttribute('data-inspect-bt');
        state.selectedBloodLens = 'ALL';
        renderAll();
        return;
      }
      const copyBtn = e.target.closest('#btnCopyInspectorContact');
      if (copyBtn) {
        const text = copyBtn.getAttribute('data-copy');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            showToast('Contact copied to clipboard.');
          });
        } else {
          showToast(text);
        }
      }
    });

    document.getElementById('riskMatrixTable').addEventListener('click', function (e) {
      const cell = e.target.closest('[data-matrix-node]');
      if (!cell) return;
      state.selectedNodeId = cell.getAttribute('data-matrix-node');
      state.selectedBloodType = cell.getAttribute('data-matrix-bt');
      state.selectedBloodLens = 'ALL';
      renderAll();
    });

    document.getElementById('emergenciesTableBody').addEventListener('click', function (e) {
      const dispatchBtn = e.target.closest('[data-dispatch-id]');
      if (dispatchBtn) {
        dispatchEmergency(dispatchBtn.getAttribute('data-dispatch-id'));
        return;
      }
      const alertBtn = e.target.closest('[data-alert-id]');
      if (alertBtn) {
        broadcastDonorAlert(alertBtn.getAttribute('data-alert-id'));
        return;
      }
      const focusBtn = e.target.closest('[data-focus-emg]');
      if (focusBtn) {
        const emg = findEmergency(focusBtn.getAttribute('data-focus-emg'));
        if (emg) {
          if (emg.needLocation && emg.needLocation.nodeId) {
            state.selectedNodeId = emg.needLocation.nodeId;
          }
          state.selectedBloodType = emg.bloodType;
          state.selectedBloodLens = emg.bloodType;
          renderAll();
        }
      }
    });

    document.getElementById('emergencySearch').addEventListener('input', function (e) {
      state.searchQuery = e.target.value;
      renderEmergenciesTable();
    });

    document.getElementById('consumptionSearch').addEventListener('input', function (e) {
      state.consumptionSearchQuery = e.target.value;
      renderConsumptionHistory();
    });

    document.getElementById('severityFilter').addEventListener('change', function (e) {
      state.severityFilter = e.target.value;
      renderEmergenciesTable();
    });

    // Emergency Modal
    document.getElementById('btnReportEmergency').addEventListener('click', function () {
      populateEmergencyModal();
      document.getElementById('emergencyModal').classList.remove('hidden');
    });
    document.getElementById('btnCloseModal').addEventListener('click', function () {
      document.getElementById('emergencyModal').classList.add('hidden');
    });
    document.getElementById('btnCancelModal').addEventListener('click', function () {
      document.getElementById('emergencyModal').classList.add('hidden');
    });
    document.getElementById('formFacilitySelect').addEventListener('change', syncFacilityFields);

    document.getElementById('emergencyForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const facId = document.getElementById('formFacilitySelect').value;
      const isCustom = facId === 'CUSTOM';
      const node = isCustom ? null : findNode(facId);

      const newEmg = {
        id: 'EMG-' + Math.floor(2100 + Math.random() * 899),
        bloodType: document.getElementById('formBloodType').value,
        component: document.getElementById('formComponent').value,
        unitsNeeded: Math.max(1, Number(document.getElementById('formUnits').value) || 4),
        severity: document.getElementById('formSeverity').value,
        category: document.getElementById('formCategory').value.trim(),
        needLocation: {
          nodeId: isCustom ? null : node.id,
          facility: isCustom
            ? document.getElementById('formCustomFacility').value.trim()
            : node.name,
          ward: document.getElementById('formWard').value.trim(),
          zone: document.getElementById('formZone').value.trim(),
          address: document.getElementById('formAddress').value.trim(),
          x: isCustom ? 350 + Math.round(Math.random() * 300) : node.x,
          y: isCustom ? 180 + Math.round(Math.random() * 220) : node.y
        },
        contact: {
          name: document.getElementById('formContactName').value.trim(),
          role: document.getElementById('formContactRole').value.trim(),
          phone: document.getElementById('formContactPhone').value.trim(),
          email: document.getElementById('formContactEmail').value.trim(),
          radio: document.getElementById('formContactRadio').value.trim()
        },
        notes: document.getElementById('formNotes').value.trim(),
        createdAt: new Date().toISOString(),
        status: 'active'
      };

      state.emergencies.unshift(newEmg);
      if (newEmg.needLocation.nodeId) {
        state.selectedNodeId = newEmg.needLocation.nodeId;
      }
      state.selectedBloodType = newEmg.bloodType;
      state.selectedBloodLens = newEmg.bloodType;

      addLog(
        'New ' +
          Data.EMERGENCY_LEVELS[newEmg.severity].shortLabel +
          ' request ' +
          newEmg.id +
          ': ' +
          newEmg.unitsNeeded +
          'u ' +
          newEmg.bloodType +
          ' at ' +
          newEmg.needLocation.facility +
          ' (' +
          newEmg.contact.phone +
          ').',
        newEmg.severity === 'critical' ? 'critical' : 'info'
      );

      document.getElementById('emergencyModal').classList.add('hidden');
      showToast('Emergency ' + newEmg.id + ' added to prediction network!');
      renderAll();
    });

    // Consumption Modal
    function openConsumption() {
      populateConsumptionModal();
      document.getElementById('consumptionModal').classList.remove('hidden');
    }
    document.getElementById('btnLogConsumption').addEventListener('click', openConsumption);
    document.getElementById('btnQuickLogConsumption').addEventListener('click', openConsumption);
    document.getElementById('btnCloseConsumptionModal').addEventListener('click', function () {
      document.getElementById('consumptionModal').classList.add('hidden');
    });
    document.getElementById('btnCancelConsumptionModal').addEventListener('click', function () {
      document.getElementById('consumptionModal').classList.add('hidden');
    });

    document.getElementById('consumptionForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const hospId = document.getElementById('consHospitalSelect').value;
      const bt = document.getElementById('consBloodType').value;
      const units = Math.max(1, Number(document.getElementById('consUnits').value) || 1);
      const dept = document.getElementById('consDepartment').value.trim();
      const cat = document.getElementById('consCategory').value.trim();
      const recordedBy = document.getElementById('consRecordedBy').value.trim();

      const hosp = findNode(hospId);
      const before = Number(hosp.inventory[bt] || 0);
      const after = Math.max(0, before - units);
      hosp.inventory[bt] = after;

      if (!hosp.dailyConsumptionHistory) hosp.dailyConsumptionHistory = {};
      if (!Array.isArray(hosp.dailyConsumptionHistory[bt])) {
        hosp.dailyConsumptionHistory[bt] = [1, 1, 1, 1, 1, 1, 0];
      }
      const arr = hosp.dailyConsumptionHistory[bt];
      arr[arr.length - 1] = Math.round((Number(arr[arr.length - 1] || 0) + units) * 10) / 10;

      const eventRecord = {
        id: 'TX-' + Math.floor(8820 + Math.random() * 999),
        timestamp: nowTimestampLabel(),
        hospitalId: hosp.id,
        hospitalName: hosp.name,
        bloodType: bt,
        units: units,
        department: dept,
        category: cat,
        recordedBy: recordedBy,
        stockAfter: after
      };
      state.consumptionEvents.unshift(eventRecord);
      state.selectedNodeId = hosp.id;
      state.selectedBloodType = bt;

      addLog(
        'Logged consumption ' +
          eventRecord.id +
          ' at ' +
          hosp.name +
          ': -' +
          units +
          'u ' +
          bt +
          ' (' +
          dept +
          ', stock left: ' +
          after +
          'u).',
        after <= hosp.safetyBufferUnits ? 'critical' : 'info'
      );

      document.getElementById('consumptionModal').classList.add('hidden');
      showToast('Recorded ' + units + 'u ' + bt + ' consumption & updated forecast!');
      renderAll();
    });

    // Register New Hospital Modal
    document.getElementById('btnAddHospital').addEventListener('click', function () {
      document.getElementById('hospitalModal').classList.remove('hidden');
    });
    document.getElementById('btnCloseHospitalModal').addEventListener('click', function () {
      document.getElementById('hospitalModal').classList.add('hidden');
    });
    document.getElementById('btnCancelHospitalModal').addEventListener('click', function () {
      document.getElementById('hospitalModal').classList.add('hidden');
    });

    document.getElementById('hospitalForm').addEventListener('submit', function (e) {
      e.preventDefault();
      const name = document.getElementById('hospName').value.trim();
      const tier = document.getElementById('hospTier').value;
      const beds = Math.max(20, Number(document.getElementById('hospBeds').value) || 250);
      const zone = document.getElementById('hospZone').value.trim();
      const address = document.getElementById('hospAddress').value.trim();
      const profile = document.getElementById('hospReserveProfile').value;
      const contactName = document.getElementById('hospContactName').value.trim();
      const contactPhone = document.getElementById('hospContactPhone').value.trim();
      const contactEmail = document.getElementById('hospContactEmail').value.trim();

      const scale = profile === 'surplus' ? 1.55 : profile === 'low' ? 0.45 : 0.95;
      const baseInv = {
        'O-': 8, 'O+': 24, 'A-': 8, 'A+': 20, 'B-': 6, 'B+': 14, 'AB-': 4, 'AB+': 10
      };
      const inv = {};
      const burn = {};
      const inc = {};
      const exp = {};
      const hist = {};

      Data.BLOOD_TYPES.forEach(function (bt) {
        inv[bt] = Math.max(1, Math.round(baseInv[bt] * scale));
        burn[bt] = Math.round((baseInv[bt] * 0.028) * 100) / 100;
        inc[bt] = Math.max(1, Math.round(baseInv[bt] * 0.45));
        exp[bt] = 1;
        const daily = Math.round(burn[bt] * 24 * 10) / 10;
        hist[bt] = [daily, daily, daily, daily, daily, daily, daily];
      });

      const newId = 'HOSP-' + Math.floor(100 + Math.random() * 899);
      const newHosp = {
        id: newId,
        name: name,
        type: 'Hospital',
        hospitalTier: tier,
        bedCapacity: beds,
        zone: zone,
        address: address,
        x: 240 + Math.round(Math.random() * 520),
        y: 120 + Math.round(Math.random() * 340),
        safetyBufferUnits: 5,
        contact: {
          name: contactName,
          role: 'Hospital Blood Bank Lead',
          phone: contactPhone,
          email: contactEmail,
          radio: 'CH-18 / HOSP-NEW'
        },
        inventory: inv,
        hourlyBurnRate: burn,
        incomingPer24h: inc,
        expiringWithin36h: exp,
        dailyConsumptionHistory: hist
      };

      state.nodes.push(newHosp);
      state.links.push(['HUB-CENTRAL', newId]);
      state.portalHospitalId = newId;
      state.selectedNodeId = newId;

      addLog(
        'Onboarded hospital ' + name + ' (' + tier + ', ' + beds + ' beds, ' + contactPhone + ') to network.',
        'success'
      );

      document.getElementById('hospitalModal').classList.add('hidden');
      document.getElementById('hospitalForm').reset();
      showToast('Connected ' + name + ' to HemoPulse Network!');
      renderAll();
    });

    document.getElementById('btnExportReport').addEventListener('click', exportJsonReport);

    document.getElementById('btnResetNetwork').addEventListener('click', function () {
      state = createDefaultState();
      saveState();
      showToast('Multi-hospital network reset to baseline telemetry.');
      renderAll();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    renderAll();
  });
})(window);
