/**
 * HemoPulse Multi-Hospital Predictive Emergency Blood Shortage Engine
 *
 * Implements:
 * 1. Empirical 7-day consumption history analytics & trend velocity estimation
 * 2. ABO/Rh compatibility graph resolution
 * 3. Multi-horizon (0..72h) shortage & stockout trajectory forecasting with
 *    historical burn momentum, diurnal trauma cycles, expiry decay, and active emergency shockwaves
 * 4. Multi-hospital network matrix & KPI aggregation
 * 5. Graph-based optimal donor-hub/peer-hospital dispatch recommender
 */
(function (global) {
  'use strict';

  const Data = global.HemoNetworkData;

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function round1(val) {
    return Math.round(val * 10) / 10;
  }

  function round2(val) {
    return Math.round(val * 100) / 100;
  }

  function getCompatibleDonorTypes(recipientType) {
    return (Data.COMPATIBLE_DONORS[recipientType] || [recipientType]).slice();
  }

  function isCompatible(donorType, recipientType) {
    const allowed = Data.COMPATIBLE_DONORS[recipientType];
    return Array.isArray(allowed) ? allowed.indexOf(donorType) !== -1 : donorType === recipientType;
  }

  function computeRouteMetrics(locA, locB, scenario) {
    const dx = (locA.x || 0) - (locB.x || 0);
    const dy = (locA.y || 0) - (locB.y || 0);
    const gridDist = Math.sqrt(dx * dx + dy * dy);
    const distanceKm = round1(Math.max(1.2, gridDist * 0.14));
    const etaMultiplier = scenario && scenario.etaMultiplier ? scenario.etaMultiplier : 1.0;
    const etaMinutes = Math.round((10 + distanceKm * 1.4) * etaMultiplier);
    return {
      distanceKm: distanceKm,
      etaMinutes: etaMinutes
    };
  }

  /**
   * Computes empirical burn velocity & 7-day trend momentum from a hospital's
   * dailyConsumptionHistory[bloodType]. Falls back to node.hourlyBurnRate if no history exists.
   */
  function computeHistoricalBurnMetrics(node, bloodType) {
    const fallbackHourly = Number((node.hourlyBurnRate && node.hourlyBurnRate[bloodType]) || 0.2);
    const series =
      node.dailyConsumptionHistory && Array.isArray(node.dailyConsumptionHistory[bloodType])
        ? node.dailyConsumptionHistory[bloodType]
        : null;

    if (!series || series.length === 0) {
      return {
        series: [round1(fallbackHourly * 24)],
        total7dConsumed: round1(fallbackHourly * 24 * 7),
        avgDaily7d: round1(fallbackHourly * 24),
        recentDaily48h: round1(fallbackHourly * 24),
        trendPercent: 0,
        empiricalHourlyBurn: round2(fallbackHourly)
      };
    }

    let sumAll = 0;
    for (let i = 0; i < series.length; i++) {
      sumAll += Number(series[i]) || 0;
    }
    const avgDaily7d = sumAll / series.length;

    const recentSlice = series.slice(-2);
    const recentDaily48h =
      recentSlice.reduce(function (s, v) {
        return s + (Number(v) || 0);
      }, 0) / recentSlice.length;

    const earlierSlice = series.slice(0, Math.max(1, series.length - 2));
    const earlierAvg =
      earlierSlice.reduce(function (s, v) {
        return s + (Number(v) || 0);
      }, 0) / earlierSlice.length;

    const trendPercent =
      earlierAvg > 0.05 ? Math.round(((recentDaily48h - earlierAvg) / earlierAvg) * 100) : 0;

    // Weight recent 48h consumption more heavily (60%) than 7d mean (40%)
    const weightedDaily = 0.6 * recentDaily48h + 0.4 * avgDaily7d;
    const empiricalHourlyBurn = Math.max(0.05, weightedDaily / 24);

    return {
      series: series.slice(),
      total7dConsumed: round1(sumAll),
      avgDaily7d: round1(avgDaily7d),
      recentDaily48h: round1(recentDaily48h),
      trendPercent: clamp(trendPercent, -75, 250),
      empiricalHourlyBurn: round2(empiricalHourlyBurn)
    };
  }

  function computeEmergencyShockUnits(node, bloodType, activeEmergencies) {
    let directUnits = 0;
    let highestSeverity = null;
    let activeCount = 0;

    for (let i = 0; i < activeEmergencies.length; i++) {
      const emg = activeEmergencies[i];
      if (emg.status !== 'active') continue;
      if (emg.bloodType !== bloodType) continue;

      const sameNode = emg.needLocation && emg.needLocation.nodeId === node.id;
      const dist = computeRouteMetrics(node, emg.needLocation || node, null).distanceKm;

      if (sameNode || dist < 4.5) {
        directUnits += Number(emg.unitsNeeded) || 0;
        activeCount += 1;
        if (
          !highestSeverity ||
          Data.EMERGENCY_LEVELS[emg.severity].priorityWeight >
            Data.EMERGENCY_LEVELS[highestSeverity].priorityWeight
        ) {
          highestSeverity = emg.severity;
        }
      } else if (node.type === 'Regional Hub' && dist < 45) {
        directUnits += (Number(emg.unitsNeeded) || 0) * 0.16;
      }
    }

    return {
      shockUnits: round1(directUnits),
      activeCount: activeCount,
      highestSeverity: highestSeverity
    };
  }

  /**
   * Computes temporal + blood-type + hospital-tier multiplier for an emergency demand pattern.
   */
  function computeDemandPatternFactor(pattern, node, bloodType, hour) {
    const activePattern =
      pattern || (Data.EMERGENCY_DEMAND_PATTERNS && Data.EMERGENCY_DEMAND_PATTERNS.steady_baseline);
    if (!activePattern) {
      return 1 + 0.18 * Math.sin(((hour + 9) / 24) * 2 * Math.PI);
    }

    const hr = Math.max(0, Number(hour) || 0);
    const btWeight =
      activePattern.bloodTypeWeights && activePattern.bloodTypeWeights[bloodType]
        ? Number(activePattern.bloodTypeWeights[bloodType])
        : 1.0;
    const tierWeight =
      activePattern.tierAffinity &&
      node &&
      node.hospitalTier &&
      activePattern.tierAffinity[node.hospitalTier]
        ? Number(activePattern.tierAffinity[node.hospitalTier])
        : 1.0;

    let wave = 1.0;
    const shape = activePattern.waveShape || 'diurnal_standard';

    if (shape === 'diurnal_standard') {
      wave = 1 + 0.18 * Math.sin(((hr + 9) / 24) * 2 * Math.PI);
    } else if (shape === 'nocturnal_trauma_wave') {
      // Peaks around evening/night hours (hr mod 24 ~ 10..18 relative to 09:30 start)
      const nightPulse = Math.max(0, Math.sin(((hr + 2) / 24) * 2 * Math.PI));
      wave = 0.85 + 0.55 * nightPulse;
    } else if (shape === 'impulse_decay') {
      // Immediate acute pulse decaying exponentially over ~14h half-life
      wave = 0.92 + 0.95 * Math.exp(-hr / 14);
    } else if (shape === 'daytime_clinic_wave') {
      // Strong daytime scheduled clinic load, quiet overnight
      const dayPulse = Math.max(0, Math.sin(((hr + 6) / 24) * 2 * Math.PI));
      wave = 0.72 + 0.75 * dayPulse;
    } else {
      // sustained_plateau
      wave = 1.05 + 0.12 * Math.sin(((hr + 9) / 24) * 2 * Math.PI);
    }

    return round2(Math.max(0.4, btWeight * tierWeight * wave));
  }

  function predictNodeBloodShortage(
    node,
    bloodType,
    activeEmergencies,
    scenario,
    horizonHours,
    demandPattern
  ) {
    const hMax = Math.max(6, Math.min(96, horizonHours || 48));
    const activeScenario = scenario || Data.SCENARIOS.baseline;
    const activePattern =
      demandPattern ||
      (Data.EMERGENCY_DEMAND_PATTERNS && Data.EMERGENCY_DEMAND_PATTERNS.steady_baseline);

    const currentUnits = Number((node.inventory && node.inventory[bloodType]) || 0);
    const hist = computeHistoricalBurnMetrics(node, bloodType);
    const baseHourlyBurn = hist.empiricalHourlyBurn;
    const incoming24 = Number((node.incomingPer24h && node.incomingPer24h[bloodType]) || 0);
    const expiring36 = Number((node.expiringWithin36h && node.expiringWithin36h[bloodType]) || 0);
    const safetyBuffer = Number(node.safetyBufferUnits || 5);

    const shock = computeEmergencyShockUnits(node, bloodType, activeEmergencies || []);

    let burnMultiplier = activeScenario.demandFactor || 1.0;
    if (hist.trendPercent >= 15) {
      // Rising 48h consumption velocity adds predictive momentum
      burnMultiplier *= 1 + clamp(hist.trendPercent / 400, 0, 0.25);
    }
    if (
      activeScenario.traumaBoost &&
      Array.isArray(activeScenario.traumaTypes) &&
      activeScenario.traumaTypes.indexOf(bloodType) !== -1
    ) {
      burnMultiplier *= activeScenario.traumaBoost;
    }
    if (shock.highestSeverity && Data.EMERGENCY_LEVELS[shock.highestSeverity]) {
      burnMultiplier *= Data.EMERGENCY_LEVELS[shock.highestSeverity].demandMultiplier;
    }

    const supplyFactor = activeScenario.supplyFactor || 1.0;
    const hourlyReplenishment = (incoming24 / 24) * supplyFactor;
    const hourlyExpiryLoss = expiring36 / 36;

    const trajectory = [];
    let hoursToStockout = null;
    let hoursToSafetyBreach = null;

    const initialEffectiveStock = currentUnits - shock.shockUnits;
    if (initialEffectiveStock <= 0) {
      hoursToStockout = 0;
      hoursToSafetyBreach = 0;
    } else if (initialEffectiveStock <= safetyBuffer) {
      hoursToSafetyBreach = 0;
    }

    trajectory.push({
      hour: 0,
      expectedUnits: round1(initialEffectiveStock),
      lowUnits: round1(initialEffectiveStock),
      highUnits: round1(initialEffectiveStock),
      safetyBuffer: safetyBuffer
    });

    let stock = initialEffectiveStock;
    let patternMultiplierSum = 0;
    for (let hr = 1; hr <= hMax; hr++) {
      const patternFactor = computeDemandPatternFactor(activePattern, node, bloodType, hr);
      patternMultiplierSum += patternFactor;
      const effectiveBurn = baseHourlyBurn * burnMultiplier * patternFactor;
      const expiryDecay = hr <= 36 ? hourlyExpiryLoss : hourlyExpiryLoss * 0.25;

      stock = stock + hourlyReplenishment - effectiveBurn - expiryDecay;

      const uncertainty = round1(Math.sqrt(hr) * (0.45 + baseHourlyBurn * 0.65));

      if (hoursToStockout === null && stock <= 0) {
        hoursToStockout = hr;
      }
      if (hoursToSafetyBreach === null && stock <= safetyBuffer) {
        hoursToSafetyBreach = hr;
      }

      trajectory.push({
        hour: hr,
        expectedUnits: round1(stock),
        lowUnits: round1(stock - uncertainty),
        highUnits: round1(stock + uncertainty),
        safetyBuffer: safetyBuffer
      });
    }

    const avgPatternFactor = round2(patternMultiplierSum / hMax);
    const endPoint = trajectory[trajectory.length - 1];
    const predictedUnitsAtHorizon = endPoint.expectedUnits;
    const deficitUnits =
      predictedUnitsAtHorizon < safetyBuffer
        ? Math.ceil(safetyBuffer - predictedUnitsAtHorizon)
        : 0;

    let riskScore = 0;
    if (hoursToStockout !== null) {
      riskScore = 65 + Math.round(35 * (1 - hoursToStockout / (hMax + 1)));
    } else if (hoursToSafetyBreach !== null) {
      riskScore = 35 + Math.round(30 * (1 - hoursToSafetyBreach / (hMax + 1)));
    } else {
      const cushionRatio = clamp(
        (predictedUnitsAtHorizon - safetyBuffer) / Math.max(10, safetyBuffer * 2),
        0,
        1
      );
      riskScore = Math.round(32 * (1 - cushionRatio));
    }
    if (shock.activeCount > 0) {
      riskScore = clamp(riskScore + 12, 0, 100);
    }
    riskScore = clamp(riskScore, 0, 100);

    let riskLevel = 'stable';
    if (riskScore >= 75 || (hoursToStockout !== null && hoursToStockout <= 12)) {
      riskLevel = 'critical';
    } else if (riskScore >= 52 || (hoursToStockout !== null && hoursToStockout <= 24)) {
      riskLevel = 'high';
    } else if (riskScore >= 32 || hoursToSafetyBreach !== null) {
      riskLevel = 'watch';
    }

    const sigma = Math.max(1.5, Math.sqrt(hMax) * 0.6);
    const z = -predictedUnitsAtHorizon / sigma;
    const shortageProbability = Math.round(clamp(1 / (1 + Math.exp(-z)), 0.02, 0.99) * 100);

    const factors = [];
    if (shock.shockUnits > 0) {
      factors.push('Active emergency demand: -' + shock.shockUnits + 'u');
    }
    if (activePattern && activePattern.id !== 'steady_baseline') {
      factors.push('Pattern: ' + activePattern.name + ' (x' + avgPatternFactor + ')');
    }
    factors.push(
      '7d history avg: ' +
        hist.avgDaily7d +
        'u/day (' +
        (hist.trendPercent >= 0 ? '+' : '') +
        hist.trendPercent +
        '% trend)'
    );
    if (expiring36 > 0) {
      factors.push(expiring36 + 'u nearing 36h expiry');
    }
    if (hourlyReplenishment < baseHourlyBurn * burnMultiplier * avgPatternFactor) {
      factors.push('Net outflow exceeds replenishment');
    } else {
      factors.push('Net positive inflow buffer');
    }

    return {
      nodeId: node.id,
      nodeName: node.name,
      bloodType: bloodType,
      currentUnits: currentUnits,
      shockUnits: shock.shockUnits,
      effectiveNetUnits: round1(initialEffectiveStock),
      safetyBuffer: safetyBuffer,
      effectiveHourlyBurn: round2(baseHourlyBurn * burnMultiplier * avgPatternFactor),
      patternMultiplier: avgPatternFactor,
      hourlyReplenishment: round2(hourlyReplenishment),
      hoursToStockout: hoursToStockout,
      hoursToSafetyBreach: hoursToSafetyBreach,
      predictedUnitsAtHorizon: predictedUnitsAtHorizon,
      deficitUnits: deficitUnits,
      riskScore: riskScore,
      riskLevel: riskLevel,
      shortageProbability: shortageProbability,
      historicalMetrics: hist,
      trajectory: trajectory,
      factors: factors
    };
  }

  function predictNetworkMatrix(nodes, activeEmergencies, scenario, horizonHours, demandPattern) {
    const cells = [];
    const byNode = {};
    let criticalCount = 0;
    let highCount = 0;
    let totalUnits = 0;
    let totalDeficitUnits = 0;
    let total7dConsumed = 0;
    let highestRiskCell = null;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      byNode[node.id] = {
        node: node,
        bloodPredictions: {},
        maxRiskScore: 0,
        worstRiskLevel: 'stable',
        worstBloodType: 'O-',
        earliestStockoutHours: null,
        totalNodeUnits: 0,
        totalNode7dConsumed: 0
      };

      for (let j = 0; j < Data.BLOOD_TYPES.length; j++) {
        const bt = Data.BLOOD_TYPES[j];
        const pred = predictNodeBloodShortage(
          node,
          bt,
          activeEmergencies,
          scenario,
          horizonHours,
          demandPattern
        );
        cells.push(pred);
        byNode[node.id].bloodPredictions[bt] = pred;
        byNode[node.id].totalNodeUnits += pred.currentUnits;
        byNode[node.id].totalNode7dConsumed += pred.historicalMetrics.total7dConsumed;
        totalUnits += pred.currentUnits;
        totalDeficitUnits += pred.deficitUnits;
        total7dConsumed += pred.historicalMetrics.total7dConsumed;

        if (pred.riskLevel === 'critical') criticalCount++;
        else if (pred.riskLevel === 'high') highCount++;

        if (pred.riskScore >= byNode[node.id].maxRiskScore) {
          byNode[node.id].maxRiskScore = pred.riskScore;
          byNode[node.id].worstRiskLevel = pred.riskLevel;
          byNode[node.id].worstBloodType = bt;
        }
        if (
          pred.hoursToStockout !== null &&
          (byNode[node.id].earliestStockoutHours === null ||
            pred.hoursToStockout < byNode[node.id].earliestStockoutHours)
        ) {
          byNode[node.id].earliestStockoutHours = pred.hoursToStockout;
        }
        if (!highestRiskCell || pred.riskScore > highestRiskCell.riskScore) {
          highestRiskCell = pred;
        }
      }
      byNode[node.id].totalNode7dConsumed = round1(byNode[node.id].totalNode7dConsumed);
    }

    const bloodTypeSummary = Data.BLOOD_TYPES.map(function (bt) {
      let stock = 0;
      let burn = 0;
      let consumed7d = 0;
      let maxRisk = 0;
      let criticalNodes = 0;
      for (let i = 0; i < nodes.length; i++) {
        const p = byNode[nodes[i].id].bloodPredictions[bt];
        stock += p.currentUnits;
        burn += p.effectiveHourlyBurn;
        consumed7d += p.historicalMetrics.total7dConsumed;
        if (p.riskScore > maxRisk) maxRisk = p.riskScore;
        if (p.riskLevel === 'critical' || p.riskLevel === 'high') criticalNodes++;
      }
      return {
        bloodType: bt,
        totalUnits: stock,
        networkBurnPerHour: round2(burn),
        total7dConsumed: round1(consumed7d),
        maxRiskScore: maxRisk,
        atRiskNodes: criticalNodes
      };
    });

    const hospitalCount = nodes.filter(function (n) {
      return n.type === 'Hospital';
    }).length;

    return {
      horizonHours: horizonHours || 48,
      cells: cells,
      byNode: byNode,
      bloodTypeSummary: bloodTypeSummary,
      kpis: {
        totalUnits: totalUnits,
        total7dConsumed: round1(total7dConsumed),
        hospitalCount: hospitalCount,
        hubCount: nodes.length - hospitalCount,
        criticalAlerts: criticalCount,
        highRiskAlerts: highCount,
        totalPredictedDeficit: totalDeficitUnits,
        activeEmergenciesCount: (activeEmergencies || []).filter(function (e) {
          return e.status === 'active';
        }).length,
        highestRiskCell: highestRiskCell
      }
    };
  }

  /**
   * Aggregates 7-day daily consumption totals across either a specific hospital or all nodes,
   * optionally filtered by a specific blood type.
   */
  function summarizeConsumptionSeries(nodes, filterNodeId, filterBloodType) {
    const days = 7;
    const totals = [0, 0, 0, 0, 0, 0, 0];
    const targetNodes = filterNodeId && filterNodeId !== 'ALL'
      ? nodes.filter(function (n) { return n.id === filterNodeId; })
      : nodes;
    const targetTypes = filterBloodType && filterBloodType !== 'ALL'
      ? [filterBloodType]
      : Data.BLOOD_TYPES;

    for (let i = 0; i < targetNodes.length; i++) {
      const node = targetNodes[i];
      for (let j = 0; j < targetTypes.length; j++) {
        const bt = targetTypes[j];
        const series =
          node.dailyConsumptionHistory && node.dailyConsumptionHistory[bt]
            ? node.dailyConsumptionHistory[bt]
            : null;
        if (!series) continue;
        for (let d = 0; d < days; d++) {
          totals[d] += Number(series[d]) || 0;
        }
      }
    }

    const rounded = totals.map(round1);
    const total7d = round1(
      rounded.reduce(function (a, b) {
        return a + b;
      }, 0)
    );
    const avgDaily = round1(total7d / days);
    const todayTotal = rounded[days - 1] || 0;
    const prevAvg =
      rounded.slice(0, days - 1).reduce(function (a, b) {
        return a + b;
      }, 0) / Math.max(1, days - 1);
    const deltaPct = prevAvg > 0 ? Math.round(((todayTotal - prevAvg) / prevAvg) * 100) : 0;

    return {
      labels: Data.HISTORY_DAY_LABELS.slice(),
      dailyTotals: rounded,
      total7d: total7d,
      avgDaily: avgDaily,
      todayTotal: todayTotal,
      deltaPct: deltaPct
    };
  }

  /**
   * Computes hourly network-wide emergency demand curve (0..hours) and comparative impact
   * across all defined Emergency Demand Patterns.
   */
  function analyzeEmergencyDemandPatterns(
    patternsMap,
    nodes,
    activeEmergencies,
    scenario,
    horizonHours,
    filterNodeId,
    filterBloodType
  ) {
    const patternIds = Object.keys(patternsMap || Data.EMERGENCY_DEMAND_PATTERNS || {});
    const targetNodes =
      filterNodeId && filterNodeId !== 'ALL'
        ? nodes.filter(function (n) {
            return n.id === filterNodeId;
          })
        : nodes;
    const targetTypes =
      filterBloodType && filterBloodType !== 'ALL' ? [filterBloodType] : Data.BLOOD_TYPES;

    const horizon = Math.min(48, Math.max(12, horizonHours || 48));
    const comparisons = [];

    for (let pIdx = 0; pIdx < patternIds.length; pIdx++) {
      const pat = patternsMap[patternIds[pIdx]];
      const matrix = predictNetworkMatrix(
        nodes,
        activeEmergencies,
        scenario,
        horizonHours || 48,
        pat
      );

      const hourlyDemandCurve = [];
      let totalProjectedDemand = 0;
      let peakUnitsPerHour = 0;
      let peakHour = 0;

      for (let hr = 0; hr <= horizon; hr++) {
        let hrDemand = 0;
        for (let nIdx = 0; nIdx < targetNodes.length; nIdx++) {
          const node = targetNodes[nIdx];
          for (let bIdx = 0; bIdx < targetTypes.length; bIdx++) {
            const bt = targetTypes[bIdx];
            const hist = computeHistoricalBurnMetrics(node, bt);
            const factor = computeDemandPatternFactor(pat, node, bt, hr);
            hrDemand += hist.empiricalHourlyBurn * factor;
          }
        }
        hrDemand = round2(hrDemand);
        hourlyDemandCurve.push({ hour: hr, unitsPerHour: hrDemand });
        if (hr > 0) totalProjectedDemand += hrDemand;
        if (hrDemand > peakUnitsPerHour) {
          peakUnitsPerHour = hrDemand;
          peakHour = hr;
        }
      }

      comparisons.push({
        pattern: pat,
        criticalAlerts: matrix.kpis.criticalAlerts,
        highRiskAlerts: matrix.kpis.highRiskAlerts,
        predictedDeficit: matrix.kpis.totalPredictedDeficit,
        highestRiskCell: matrix.kpis.highestRiskCell,
        totalProjectedDemand: round1(totalProjectedDemand),
        peakUnitsPerHour: round2(peakUnitsPerHour),
        peakHour: peakHour,
        hourlyDemandCurve: hourlyDemandCurve
      });
    }

    return comparisons;
  }

  function recommendDispatchRoutes(need, nodes, activeEmergencies, scenario, demandPattern) {
    const targetType = need.bloodType;
    const unitsNeeded = Math.max(1, Number(need.unitsNeeded) || 1);
    const compatibleTypes = getCompatibleDonorTypes(targetType);
    const needLoc = need.needLocation || { x: 500, y: 300, nodeId: null };

    const candidates = [];

    for (let i = 0; i < nodes.length; i++) {
      const donorNode = nodes[i];
      if (needLoc.nodeId && donorNode.id === needLoc.nodeId) continue;

      const route = computeRouteMetrics(donorNode, needLoc, scenario);

      for (let k = 0; k < compatibleTypes.length; k++) {
        const donorType = compatibleTypes[k];
        const available = Number((donorNode.inventory && donorNode.inventory[donorType]) || 0);
        if (available <= 0) continue;

        const pred24 = predictNodeBloodShortage(
          donorNode,
          donorType,
          activeEmergencies,
          scenario,
          24,
          demandPattern
        );
        const protectedReserve = Math.max(3, Math.ceil(pred24.effectiveHourlyBurn * 6));
        const safeTransferable = Math.max(0, available - protectedReserve);
        if (safeTransferable <= 0) continue;

        const isExact = donorType === targetType;
        const dispatchUnits = Math.min(unitsNeeded, safeTransferable);
        const coverageRatio = dispatchUnits / unitsNeeded;

        const matchScore = isExact ? 35 : Math.max(10, 26 - k * 3);
        const coverageScore = coverageRatio * 30;
        const etaScore = clamp(22 - route.etaMinutes * 0.25, 0, 22);
        const donorHealthScore = clamp(13 * (1 - pred24.riskScore / 100), 0, 13);
        const totalScore = Math.round(matchScore + coverageScore + etaScore + donorHealthScore);

        candidates.push({
          donorNodeId: donorNode.id,
          donorNodeName: donorNode.name,
          donorType: donorNode.type,
          donorZone: donorNode.zone,
          donorContact: donorNode.contact,
          donorBloodType: donorType,
          isExactMatch: isExact,
          availableUnits: available,
          safeTransferableUnits: safeTransferable,
          recommendedUnits: dispatchUnits,
          coveragePercent: Math.round(coverageRatio * 100),
          distanceKm: route.distanceKm,
          etaMinutes: route.etaMinutes,
          donorPostRiskScore: pred24.riskScore,
          score: totalScore
        });
      }
    }

    candidates.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.etaMinutes - b.etaMinutes;
    });

    return candidates;
  }

  global.HemoPredictionEngine = {
    getCompatibleDonorTypes: getCompatibleDonorTypes,
    isCompatible: isCompatible,
    computeRouteMetrics: computeRouteMetrics,
    computeHistoricalBurnMetrics: computeHistoricalBurnMetrics,
    computeDemandPatternFactor: computeDemandPatternFactor,
    predictNodeBloodShortage: predictNodeBloodShortage,
    predictNetworkMatrix: predictNetworkMatrix,
    summarizeConsumptionSeries: summarizeConsumptionSeries,
    analyzeEmergencyDemandPatterns: analyzeEmergencyDemandPatterns,
    recommendDispatchRoutes: recommendDispatchRoutes
  };
})(typeof window !== 'undefined' ? window : globalThis);
