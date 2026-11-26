(function (global) {
  'use strict';

  const Data = global.HemoNetworkData;
  const Engine = global.HemoPredictionEngine;

  function assert(condition, message) {
    if (!condition) {
      throw new Error('Assertion failed: ' + message);
    }
  }

  function runAllTests() {
    const results = [];

    function test(name, fn) {
      try {
        fn();
        results.push({ name: name, passed: true });
      } catch (err) {
        results.push({ name: name, passed: false, error: err.message });
      }
    }

    test('ABO/Rh compatibility graph enforces safe transfusion rules', function () {
      assert(Engine.isCompatible('O-', 'AB+') === true, 'O- must be universal RBC donor');
      assert(Engine.isCompatible('O-', 'O-') === true, 'O- must match O-');
      assert(Engine.isCompatible('O+', 'O-') === false, 'O+ cannot donate to O-');
      assert(Engine.isCompatible('A+', 'B+') === false, 'A+ cannot donate to B+');
      const abPlusDonors = Engine.getCompatibleDonorTypes('AB+');
      assert(abPlusDonors.length === 8, 'AB+ must accept all 8 blood types');
      assert(abPlusDonors[0] === 'AB+', 'Exact match must be ordered first');
    });

    test('Multi-hospital platform defines 6+ hospitals, hubs, locations, and contacts', function () {
      const hospitals = Data.INITIAL_NODES.filter(function (n) {
        return n.type === 'Hospital';
      });
      assert(hospitals.length >= 6, 'Expected at least 6 connected hospitals');
      Data.INITIAL_NODES.forEach(function (n) {
        assert(n.contact && n.contact.name && n.contact.phone && n.contact.email, 'Node missing contact info: ' + n.id);
        assert(n.zone && n.address && typeof n.x === 'number' && typeof n.y === 'number', 'Node missing location: ' + n.id);
        assert(n.dailyConsumptionHistory && Array.isArray(n.dailyConsumptionHistory['O-']), 'Node missing 7-day consumption history: ' + n.id);
      });

      assert(Data.INITIAL_CONSUMPTION_EVENTS.length >= 5, 'Expected initial consumption ledger events');
      Data.INITIAL_EMERGENCIES.forEach(function (emg) {
        assert(Data.BLOOD_TYPES.indexOf(emg.bloodType) !== -1, 'Invalid blood type on ' + emg.id);
        assert(Boolean(Data.EMERGENCY_LEVELS[emg.severity]), 'Invalid emergency level on ' + emg.id);
        assert(emg.needLocation && emg.needLocation.facility && emg.needLocation.zone && emg.needLocation.address, 'Missing need location on ' + emg.id);
        assert(emg.contact && emg.contact.name && emg.contact.phone && emg.contact.email, 'Missing contact on ' + emg.id);
      });
    });

    test('Consumption history derives empirical burn rate and rising trend velocity', function () {
      const northgate = Data.INITIAL_NODES[1];
      const metrics = Engine.computeHistoricalBurnMetrics(northgate, 'O-');
      assert(metrics.series.length === 7, 'Expected 7-day series');
      assert(metrics.total7dConsumed > 0, 'Total 7d consumed must be positive');
      assert(metrics.trendPercent > 0, 'Northgate O- consumption trend should be positive');
      assert(metrics.empiricalHourlyBurn > 0, 'Empirical hourly burn must be positive');
    });

    test('Summarize consumption series aggregates across single hospital or whole network', function () {
      const allSummary = Engine.summarizeConsumptionSeries(Data.INITIAL_NODES, 'ALL', 'ALL');
      const oneSummary = Engine.summarizeConsumptionSeries(Data.INITIAL_NODES, 'HOSP-TRAUMA-N', 'ALL');
      assert(allSummary.dailyTotals.length === 7, 'Expected 7 daily buckets');
      assert(allSummary.total7d > oneSummary.total7d, 'Network total must exceed single hospital total');
      assert(oneSummary.avgDaily > 0, 'Single hospital daily average must be positive');
    });

    test('Acute emergency demand triggers immediate stockout prediction', function () {
      const northgate = Data.INITIAL_NODES[1];
      const pred = Engine.predictNodeBloodShortage(
        northgate,
        'O-',
        Data.INITIAL_EMERGENCIES,
        Data.SCENARIOS.baseline,
        48
      );
      assert(pred.hoursToStockout === 0, 'Expected immediate 0h stockout when emergency demand exceeds inventory');
      assert(pred.riskLevel === 'critical', 'Expected critical risk level');
      assert(pred.riskScore >= 85, 'Expected high risk score >= 85');
      assert(pred.trajectory.length === 49, 'Expected 0..48h trajectory points');
    });

    test('Mass casualty scenario increases predicted risk vs donor drive scenario', function () {
      const central = Data.INITIAL_NODES[0];
      const predMass = Engine.predictNodeBloodShortage(
        central,
        'O-',
        Data.INITIAL_EMERGENCIES,
        Data.SCENARIOS.mass_casualty,
        48
      );
      const predDrive = Engine.predictNodeBloodShortage(
        central,
        'O-',
        Data.INITIAL_EMERGENCIES,
        Data.SCENARIOS.donor_drive,
        48
      );
      assert(predMass.predictedUnitsAtHorizon < predDrive.predictedUnitsAtHorizon, 'Mass casualty must deplete faster than donor drive');
      assert(predMass.riskScore >= predDrive.riskScore, 'Mass casualty must yield higher risk score');
    });

    test('Dispatch recommender selects safe donor hub or peer hospital without starving reserve', function () {
      const emg = Data.INITIAL_EMERGENCIES[0];
      const routes = Engine.recommendDispatchRoutes(
        emg,
        Data.INITIAL_NODES,
        Data.INITIAL_EMERGENCIES,
        Data.SCENARIOS.baseline
      );
      assert(routes.length > 0, 'Expected at least one viable dispatch route');
      const top = routes[0];
      assert(top.donorNodeId !== emg.needLocation.nodeId, 'Must not dispatch from requesting hospital');
      assert(top.isExactMatch === true, 'Exact O- match should be available');
      assert(top.recommendedUnits > 0 && top.recommendedUnits <= top.safeTransferableUnits, 'Must respect donor safety buffer');
      assert(top.donorContact && top.donorContact.phone, 'Route must expose donor contact');
    });

    test('Network matrix aggregates multi-hospital KPIs and 7d consumption', function () {
      const matrix = Engine.predictNetworkMatrix(
        Data.INITIAL_NODES,
        Data.INITIAL_EMERGENCIES,
        Data.SCENARIOS.baseline,
        48
      );
      assert(matrix.cells.length === Data.INITIAL_NODES.length * Data.BLOOD_TYPES.length, 'Matrix cell count mismatch');
      assert(matrix.kpis.hospitalCount >= 6, 'Expected 6+ hospitals in KPI');
      assert(matrix.kpis.total7dConsumed > 0, 'Expected positive 7d consumption total');
      assert(matrix.kpis.criticalAlerts >= 1, 'Expected critical shortage alerts');
    });

    test('Emergency demand patterns alter hourly demand wave and shortage predictions', function () {
      const traumaPattern = Data.EMERGENCY_DEMAND_PATTERNS.weekend_highway_trauma;
      const mciPattern = Data.EMERGENCY_DEMAND_PATTERNS.mass_casualty_shockwave;
      const steadyPattern = Data.EMERGENCY_DEMAND_PATTERNS.steady_baseline;
      const northgate = Data.INITIAL_NODES[1];

      const fSteady = Engine.computeDemandPatternFactor(steadyPattern, northgate, 'O-', 2);
      const fMci = Engine.computeDemandPatternFactor(mciPattern, northgate, 'O-', 2);
      assert(fMci > fSteady, 'MCI shockwave factor must exceed steady baseline at hour 2 for O- at trauma hospital');

      const predSteady = Engine.predictNodeBloodShortage(
        Data.INITIAL_NODES[0],
        'O-',
        Data.INITIAL_EMERGENCIES,
        Data.SCENARIOS.baseline,
        48,
        steadyPattern
      );
      const predTrauma = Engine.predictNodeBloodShortage(
        Data.INITIAL_NODES[0],
        'O-',
        Data.INITIAL_EMERGENCIES,
        Data.SCENARIOS.baseline,
        48,
        traumaPattern
      );
      assert(predTrauma.predictedUnitsAtHorizon < predSteady.predictedUnitsAtHorizon, 'Weekend trauma pattern must deplete O- faster than baseline');

      const analyses = Engine.analyzeEmergencyDemandPatterns(
        Data.EMERGENCY_DEMAND_PATTERNS,
        Data.INITIAL_NODES,
        Data.INITIAL_EMERGENCIES,
        Data.SCENARIOS.baseline,
        48,
        'ALL',
        'ALL'
      );
      assert(analyses.length >= 6, 'Expected comparative analysis for all 6 emergency demand patterns');
      assert(analyses[0].hourlyDemandCurve.length === 49, 'Expected 0..48h demand curve');
    });

    return results;
  }

  global.HemoTestRunner = { runAllTests: runAllTests };
})(typeof window !== 'undefined' ? window : globalThis);
