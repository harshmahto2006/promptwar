/**
 * HemoPulse Multi-Hospital Predictive Emergency Blood Shortage Network
 * Core domain definitions, ABO/Rh compatibility graph, multi-hospital nodes,
 * 7-day per-hospital consumption history, transfusion event ledger,
 * active emergency requests, and stress-test scenarios.
 */
(function (global) {
  'use strict';

  const BLOOD_TYPES = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];

  const COMPATIBLE_DONORS = {
    'O-':  ['O-'],
    'O+':  ['O+', 'O-'],
    'A-':  ['A-', 'O-'],
    'A+':  ['A+', 'A-', 'O+', 'O-'],
    'B-':  ['B-', 'O-'],
    'B+':  ['B+', 'B-', 'O+', 'O-'],
    'AB-': ['AB-', 'A-', 'B-', 'O-'],
    'AB+': ['AB+', 'AB-', 'A+', 'A-', 'B+', 'B-', 'O+', 'O-']
  };

  const EMERGENCY_LEVELS = {
    critical: {
      label: 'Code Red — Critical',
      shortLabel: 'CODE RED',
      priorityWeight: 3.0,
      slaMinutes: 30,
      demandMultiplier: 1.65
    },
    urgent: {
      label: 'Code Amber — Urgent',
      shortLabel: 'URGENT',
      priorityWeight: 2.0,
      slaMinutes: 90,
      demandMultiplier: 1.35
    },
    elevated: {
      label: 'Watch — Elevated',
      shortLabel: 'WATCH',
      priorityWeight: 1.3,
      slaMinutes: 240,
      demandMultiplier: 1.15
    },
    routine: {
      label: 'Routine Replenishment',
      shortLabel: 'ROUTINE',
      priorityWeight: 1.0,
      slaMinutes: 480,
      demandMultiplier: 1.0
    }
  };

  const SCENARIOS = {
    baseline: {
      id: 'baseline',
      name: 'Baseline Telemetry',
      description: 'Predictions calibrated directly from each hospital’s 7-day consumption history & current emergencies.',
      demandFactor: 1.0,
      traumaTypes: [],
      etaMultiplier: 1.0,
      supplyFactor: 1.0
    },
    mass_casualty: {
      id: 'mass_casualty',
      name: 'Highway Mass Casualty Surge',
      description: 'Multi-vehicle incident: +140% O-/O+/A+ trauma burn rate across metro hospitals.',
      demandFactor: 1.45,
      traumaTypes: ['O-', 'O+', 'A+'],
      traumaBoost: 2.4,
      etaMultiplier: 1.15,
      supplyFactor: 0.95
    },
    storm_delay: {
      id: 'storm_delay',
      name: 'Severe Weather Logistics Delay',
      description: 'Flooded corridors increase transit ETAs (+85%) and cut scheduled replenishment by 40%.',
      demandFactor: 1.1,
      traumaTypes: [],
      etaMultiplier: 1.85,
      supplyFactor: 0.6
    },
    donor_drive: {
      id: 'donor_drive',
      name: 'Regional Donor Drive Surge',
      description: 'Coordinated mobile blood drives boost incoming supply by +65% over 48h.',
      demandFactor: 1.0,
      traumaTypes: [],
      etaMultiplier: 1.0,
      supplyFactor: 1.65
    }
  };

  /**
   * Helper to build deterministic 7-day daily consumption history (Day -6 .. Today)
   * from a baseline hourly burn rate and trend slope.
   */
  function buildSevenDayHistory(hourlyBurnMap, trendSlope) {
    const history = {};
    const slope = typeof trendSlope === 'number' ? trendSlope : 0;
    const dayWeights = [0.92, 0.96, 1.02, 0.98, 1.04, 1.08, 1.12];

    for (let i = 0; i < BLOOD_TYPES.length; i++) {
      const bt = BLOOD_TYPES[i];
      const baseDaily = (hourlyBurnMap[bt] || 0.2) * 24;
      const series = [];
      for (let d = 0; d < 7; d++) {
        const trendMultiplier = 1 + slope * ((d - 3) / 3);
        const wave = dayWeights[d];
        const val = Math.max(0.5, Math.round(baseDaily * trendMultiplier * wave * 10) / 10);
        series.push(val);
      }
      history[bt] = series;
    }
    return history;
  }

  const HISTORY_DAY_LABELS = ['6d ago', '5d ago', '4d ago', '3d ago', '2d ago', 'Yesterday', 'Today'];

  /**
   * Emergency Demand Patterns model temporal wave shapes, blood-type affinity weights,
   * and hospital-tier exposure across the multi-hospital network.
   */
  const EMERGENCY_DEMAND_PATTERNS = {
    steady_baseline: {
      id: 'steady_baseline',
      name: 'Steady Clinical Baseline',
      category: 'Baseline Diurnal',
      waveShape: 'diurnal_standard',
      description: 'Normal daytime surgical peak (+18%) and late-night trough (-15%) across all hospitals.',
      peakWindowLabel: '10:00 – 16:00',
      peakMultiplier: 1.18,
      targetTiers: ['All Facilities'],
      bloodTypeWeights: {
        'O-': 1.0, 'O+': 1.0, 'A-': 1.0, 'A+': 1.0, 'B-': 1.0, 'B+': 1.0, 'AB-': 1.0, 'AB+': 1.0
      },
      tierAffinity: {}
    },
    weekend_highway_trauma: {
      id: 'weekend_highway_trauma',
      name: 'Weekend Highway Trauma Surge',
      category: 'Trauma / MVA Wave',
      waveShape: 'nocturnal_trauma_wave',
      description: 'Evening/overnight multi-vehicle trauma spikes heavily consuming O-, O+, and A+ at Trauma Hospitals.',
      peakWindowLabel: '19:00 – 03:00 (+120%)',
      peakMultiplier: 2.2,
      targetTiers: ['Level-1 Trauma Hospital', 'Level-2 Trauma & Coastal Hospital'],
      bloodTypeWeights: {
        'O-': 2.2, 'O+': 1.9, 'A-': 1.35, 'A+': 1.4, 'B-': 1.1, 'B+': 1.15, 'AB-': 1.0, 'AB+': 1.05
      },
      tierAffinity: {
        'Level-1 Trauma Hospital': 1.3,
        'Level-2 Trauma & Coastal Hospital': 1.25,
        'Academic Teaching Hospital': 1.1
      }
    },
    obstetric_hemorrhage_cluster: {
      id: 'obstetric_hemorrhage_cluster',
      name: 'Obstetric & Maternal Hemorrhage Pulse',
      category: 'Maternal / Perioperative',
      waveShape: 'impulse_decay',
      description: 'Acute 0–10h postpartum & surgical bleed clusters spiking O-, B-, and A- demand at Specialty Hospitals.',
      peakWindowLabel: '0–10h Acute Pulse (+110%)',
      peakMultiplier: 2.1,
      targetTiers: ['Cardiac & Maternity Hospital', 'Academic Teaching Hospital'],
      bloodTypeWeights: {
        'O-': 1.85, 'O+': 1.3, 'A-': 1.65, 'A+': 1.25, 'B-': 1.95, 'B+': 1.35, 'AB-': 1.4, 'AB+': 1.1
      },
      tierAffinity: {
        'Cardiac & Maternity Hospital': 1.35,
        'Academic Teaching Hospital': 1.15
      }
    },
    seasonal_outbreak_surge: {
      id: 'seasonal_outbreak_surge',
      name: 'Seasonal Outbreak / Dengue & Oncology Wave',
      category: 'Infectious / Hematology',
      waveShape: 'sustained_plateau',
      description: 'Sustained 48–72h elevated transfusion load across A+, B+, O+, and AB+ in Pediatric & General wards.',
      peakWindowLabel: 'Sustained 72h Plateau (+65%)',
      peakMultiplier: 1.65,
      targetTiers: ['Pediatric & Oncology Specialty', 'Community General Hospital', 'General Acute Hospital'],
      bloodTypeWeights: {
        'O-': 1.25, 'O+': 1.6, 'A-': 1.25, 'A+': 1.65, 'B-': 1.3, 'B+': 1.7, 'AB-': 1.25, 'AB+': 1.55
      },
      tierAffinity: {
        'Pediatric & Oncology Specialty': 1.35,
        'Community General Hospital': 1.2,
        'General Acute Hospital': 1.2
      }
    },
    mass_casualty_shockwave: {
      id: 'mass_casualty_shockwave',
      name: 'Mass Casualty Incident (MCI) Shockwave',
      category: 'Disaster / Code Red',
      waveShape: 'impulse_decay',
      description: 'Immediate exponential trauma shockwave (0–12h peak x2.8) straining universal O- and O+ reserves.',
      peakWindowLabel: '0–12h Exponential Shock (+180%)',
      peakMultiplier: 2.8,
      targetTiers: ['Level-1 Trauma Hospital', 'Academic Teaching Hospital', 'Level-2 Trauma & Coastal Hospital'],
      bloodTypeWeights: {
        'O-': 2.8, 'O+': 2.4, 'A-': 1.65, 'A+': 1.7, 'B-': 1.3, 'B+': 1.35, 'AB-': 1.2, 'AB+': 1.2
      },
      tierAffinity: {
        'Level-1 Trauma Hospital': 1.35,
        'Level-2 Trauma & Coastal Hospital': 1.25,
        'Academic Teaching Hospital': 1.2
      }
    },
    pediatric_scheduled_cluster: {
      id: 'pediatric_scheduled_cluster',
      name: 'Pediatric & Thalassemia Clinic Cycle',
      category: 'Scheduled Chronic / Peds',
      waveShape: 'daytime_clinic_wave',
      description: 'Predictable daytime infusion spikes (+75% during 08:00–17:00) at Pediatric & Teaching hospitals.',
      peakWindowLabel: '08:00 – 17:00 (+75%)',
      peakMultiplier: 1.75,
      targetTiers: ['Pediatric & Oncology Specialty', 'Academic Teaching Hospital'],
      bloodTypeWeights: {
        'O-': 1.25, 'O+': 1.45, 'A-': 1.35, 'A+': 1.55, 'B-': 1.4, 'B+': 1.5, 'AB-': 1.3, 'AB+': 1.4
      },
      tierAffinity: {
        'Pediatric & Oncology Specialty': 1.4,
        'Academic Teaching Hospital': 1.15
      }
    }
  };

  const INITIAL_NODES = [
    {
      id: 'HUB-CENTRAL',
      name: 'Central Metro Blood Bank',
      type: 'Regional Hub',
      hospitalTier: 'Central Blood Distribution Hub',
      bedCapacity: 0,
      zone: 'Central District',
      address: '410 Red Cross Plaza, Central Metro',
      x: 490,
      y: 285,
      safetyBufferUnits: 8,
      contact: {
        name: 'Dr. Kavita Nair',
        role: 'Chief Transfusion Officer',
        phone: '+1-555-0140-911',
        email: 'dispatch@centralbloodbank.org',
        radio: 'CH-12 / MED-NET-01'
      },
      inventory: {
        'O-': 16, 'O+': 44, 'A-': 18, 'A+': 40, 'B-': 12, 'B+': 30, 'AB-': 8, 'AB+': 19
      },
      hourlyBurnRate: {
        'O-': 0.50, 'O+': 0.90, 'A-': 0.28, 'A+': 0.68, 'B-': 0.20, 'B+': 0.46, 'AB-': 0.13, 'AB+': 0.26
      },
      incomingPer24h: {
        'O-': 12, 'O+': 26, 'A-': 9, 'A+': 20, 'B-': 7, 'B+': 15, 'AB-': 4, 'AB+': 8
      },
      expiringWithin36h: {
        'O-': 2, 'O+': 4, 'A-': 1, 'A+': 3, 'B-': 1, 'B+': 2, 'AB-': 1, 'AB+': 2
      },
      trendSlope: 0.04
    },
    {
      id: 'HOSP-TRAUMA-N',
      name: 'Northgate Level-1 Trauma Hospital',
      type: 'Hospital',
      hospitalTier: 'Level-1 Trauma Hospital',
      bedCapacity: 620,
      zone: 'North Sector',
      address: '880 Northgate Expressway, Trauma Wing B',
      x: 260,
      y: 115,
      safetyBufferUnits: 6,
      contact: {
        name: 'Dr. Marcus Vance',
        role: 'Trauma Blood Coordinator',
        phone: '+1-555-0182-404',
        email: 'trauma-blood@northgatehealth.org',
        radio: 'CH-04 / TRAUMA-NORTH'
      },
      inventory: {
        'O-': 5, 'O+': 19, 'A-': 7, 'A+': 16, 'B-': 4, 'B+': 12, 'AB-': 3, 'AB+': 9
      },
      hourlyBurnRate: {
        'O-': 0.48, 'O+': 0.85, 'A-': 0.24, 'A+': 0.58, 'B-': 0.16, 'B+': 0.38, 'AB-': 0.10, 'AB+': 0.20
      },
      incomingPer24h: {
        'O-': 4, 'O+': 12, 'A-': 3, 'A+': 10, 'B-': 2, 'B+': 7, 'AB-': 2, 'AB+': 4
      },
      expiringWithin36h: {
        'O-': 1, 'O+': 2, 'A-': 1, 'A+': 2, 'B-': 0, 'B+': 1, 'AB-': 0, 'AB+': 1
      },
      trendSlope: 0.16
    },
    {
      id: 'HOSP-MERCY-E',
      name: 'Eastside Mercy Cardiac & Maternity',
      type: 'Hospital',
      hospitalTier: 'Cardiac & Maternity Hospital',
      bedCapacity: 440,
      zone: 'East Harbor',
      address: '215 Harborview Blvd, Surgical Tower 3',
      x: 805,
      y: 165,
      safetyBufferUnits: 5,
      contact: {
        name: 'Elena Rostova, RN',
        role: 'Perioperative Blood Lead',
        phone: '+1-555-0166-220',
        email: 'bloodbank@eastsidemercy.org',
        radio: 'CH-07 / MERCY-EAST'
      },
      inventory: {
        'O-': 9, 'O+': 25, 'A-': 6, 'A+': 22, 'B-': 3, 'B+': 10, 'AB-': 2, 'AB+': 11
      },
      hourlyBurnRate: {
        'O-': 0.30, 'O+': 0.52, 'A-': 0.26, 'A+': 0.55, 'B-': 0.25, 'B+': 0.44, 'AB-': 0.12, 'AB+': 0.22
      },
      incomingPer24h: {
        'O-': 4, 'O+': 10, 'A-': 4, 'A+': 11, 'B-': 2, 'B+': 8, 'AB-': 1, 'AB+': 4
      },
      expiringWithin36h: {
        'O-': 1, 'O+': 3, 'A-': 1, 'A+': 2, 'B-': 1, 'B+': 1, 'AB-': 0, 'AB+': 1
      },
      trendSlope: 0.12
    },
    {
      id: 'HOSP-VALLEY-W',
      name: 'West Valley General Hospital',
      type: 'Hospital',
      hospitalTier: 'Community General Hospital',
      bedCapacity: 310,
      zone: 'West Valley',
      address: '1420 Oakridge Ave, Emergency Dept',
      x: 175,
      y: 430,
      safetyBufferUnits: 5,
      contact: {
        name: 'David Morales',
        role: 'Lab & Blood Bank Supervisor',
        phone: '+1-555-0133-778',
        email: 'hemovigilance@westvalleygen.org',
        radio: 'CH-09 / VALLEY-WEST'
      },
      inventory: {
        'O-': 12, 'O+': 32, 'A-': 14, 'A+': 28, 'B-': 9, 'B+': 21, 'AB-': 6, 'AB+': 14
      },
      hourlyBurnRate: {
        'O-': 0.20, 'O+': 0.42, 'A-': 0.18, 'A+': 0.38, 'B-': 0.14, 'B+': 0.30, 'AB-': 0.08, 'AB+': 0.15
      },
      incomingPer24h: {
        'O-': 6, 'O+': 14, 'A-': 5, 'A+': 11, 'B-': 4, 'B+': 8, 'AB-': 3, 'AB+': 5
      },
      expiringWithin36h: {
        'O-': 0, 'O+': 2, 'A-': 1, 'A+': 1, 'B-': 0, 'B+': 1, 'AB-': 0, 'AB+': 1
      },
      trendSlope: -0.05
    },
    {
      id: 'HOSP-SOUTH-CH',
      name: 'Southbay Coastal Medical Center',
      type: 'Hospital',
      hospitalTier: 'Level-2 Trauma & Coastal Hospital',
      bedCapacity: 480,
      zone: 'South Coastal',
      address: '509 Coastal Pkwy, Critical Care Wing',
      x: 775,
      y: 445,
      safetyBufferUnits: 6,
      contact: {
        name: 'Dr. Priya Deshmukh',
        role: 'Emergency Hematology Lead',
        phone: '+1-555-0194-305',
        email: 'stat-blood@southbaymed.org',
        radio: 'CH-15 / COAST-SOUTH'
      },
      inventory: {
        'O-': 4, 'O+': 14, 'A-': 4, 'A+': 15, 'B-': 5, 'B+': 11, 'AB-': 2, 'AB+': 7
      },
      hourlyBurnRate: {
        'O-': 0.36, 'O+': 0.68, 'A-': 0.28, 'A+': 0.48, 'B-': 0.18, 'B+': 0.36, 'AB-': 0.11, 'AB+': 0.19
      },
      incomingPer24h: {
        'O-': 3, 'O+': 10, 'A-': 2, 'A+': 9, 'B-': 3, 'B+': 6, 'AB-': 1, 'AB+': 3
      },
      expiringWithin36h: {
        'O-': 1, 'O+': 2, 'A-': 1, 'A+': 1, 'B-': 0, 'B+': 1, 'AB-': 1, 'AB+': 0
      },
      trendSlope: 0.14
    },
    {
      id: 'HOSP-PEDIATRIC-NW',
      name: 'St. Jude Pediatric & Oncology Hospital',
      type: 'Hospital',
      hospitalTier: 'Pediatric & Oncology Specialty',
      bedCapacity: 290,
      zone: 'Northwest Ridge',
      address: '305 Willow Creek Rd, Hematology Pavilion',
      x: 135,
      y: 235,
      safetyBufferUnits: 5,
      contact: {
        name: 'Dr. Hannah Cho',
        role: 'Pediatric Transfusion Director',
        phone: '+1-555-0157-612',
        email: 'blood-service@stjudepeds.org',
        radio: 'CH-06 / PEDS-NW'
      },
      inventory: {
        'O-': 7, 'O+': 16, 'A-': 8, 'A+': 18, 'B-': 6, 'B+': 14, 'AB-': 4, 'AB+': 9
      },
      hourlyBurnRate: {
        'O-': 0.24, 'O+': 0.38, 'A-': 0.22, 'A+': 0.35, 'B-': 0.15, 'B+': 0.28, 'AB-': 0.09, 'AB+': 0.14
      },
      incomingPer24h: {
        'O-': 5, 'O+': 9, 'A-': 5, 'A+': 8, 'B-': 3, 'B+': 6, 'AB-': 2, 'AB+': 4
      },
      expiringWithin36h: {
        'O-': 1, 'O+': 1, 'A-': 1, 'A+': 1, 'B-': 0, 'B+': 1, 'AB-': 0, 'AB+': 0
      },
      trendSlope: 0.08
    },
    {
      id: 'HOSP-METRO-NE',
      name: 'Metro General Teaching Hospital',
      type: 'Hospital',
      hospitalTier: 'Academic Teaching Hospital',
      bedCapacity: 740,
      zone: 'Northeast Corridor',
      address: '950 Civic Center Ave, Surgical Block A',
      x: 645,
      y: 105,
      safetyBufferUnits: 7,
      contact: {
        name: 'Dr. Tariq Al-Mansoor',
        role: 'Director of Blood Services',
        phone: '+1-555-0171-889',
        email: 'transfusion@metrogeneral.edu',
        radio: 'CH-11 / METRO-NE'
      },
      inventory: {
        'O-': 11, 'O+': 28, 'A-': 10, 'A+': 26, 'B-': 8, 'B+': 20, 'AB-': 5, 'AB+': 13
      },
      hourlyBurnRate: {
        'O-': 0.32, 'O+': 0.62, 'A-': 0.25, 'A+': 0.54, 'B-': 0.17, 'B+': 0.39, 'AB-': 0.11, 'AB+': 0.21
      },
      incomingPer24h: {
        'O-': 7, 'O+': 15, 'A-': 6, 'A+': 13, 'B-': 4, 'B+': 9, 'AB-': 3, 'AB+': 5
      },
      expiringWithin36h: {
        'O-': 1, 'O+': 2, 'A-': 1, 'A+': 2, 'B-': 1, 'B+': 1, 'AB-': 0, 'AB+': 1
      },
      trendSlope: 0.05
    },
    {
      id: 'HUB-UNIVERSITY',
      name: 'University Hematology & Reserve',
      type: 'Regional Hub',
      hospitalTier: 'Academic Blood Reserve Hub',
      bedCapacity: 0,
      zone: 'Midtown Campus',
      address: '72 University Medical Way, Bldg 4',
      x: 475,
      y: 485,
      safetyBufferUnits: 7,
      contact: {
        name: 'Samuel Okafor',
        role: 'Regional Logistics Director',
        phone: '+1-555-0118-990',
        email: 'reserve@univhematology.edu',
        radio: 'CH-02 / UNIV-RES'
      },
      inventory: {
        'O-': 19, 'O+': 38, 'A-': 20, 'A+': 34, 'B-': 14, 'B+': 26, 'AB-': 8, 'AB+': 16
      },
      hourlyBurnRate: {
        'O-': 0.26, 'O+': 0.44, 'A-': 0.19, 'A+': 0.35, 'B-': 0.13, 'B+': 0.27, 'AB-': 0.08, 'AB+': 0.15
      },
      incomingPer24h: {
        'O-': 11, 'O+': 20, 'A-': 9, 'A+': 16, 'B-': 7, 'B+': 12, 'AB-': 4, 'AB+': 7
      },
      expiringWithin36h: {
        'O-': 1, 'O+': 2, 'A-': 1, 'A+': 2, 'B-': 1, 'B+': 2, 'AB-': 0, 'AB+': 1
      },
      trendSlope: -0.02
    }
  ].map(function (node) {
    node.dailyConsumptionHistory = buildSevenDayHistory(node.hourlyBurnRate, node.trendSlope);
    return node;
  });

  const INITIAL_LINKS = [
    ['HUB-CENTRAL', 'HOSP-TRAUMA-N'],
    ['HUB-CENTRAL', 'HOSP-PEDIATRIC-NW'],
    ['HUB-CENTRAL', 'HOSP-METRO-NE'],
    ['HUB-CENTRAL', 'HOSP-MERCY-E'],
    ['HUB-CENTRAL', 'HOSP-VALLEY-W'],
    ['HUB-CENTRAL', 'HOSP-SOUTH-CH'],
    ['HUB-CENTRAL', 'HUB-UNIVERSITY'],
    ['HOSP-TRAUMA-N', 'HOSP-PEDIATRIC-NW'],
    ['HOSP-TRAUMA-N', 'HOSP-METRO-NE'],
    ['HOSP-METRO-NE', 'HOSP-MERCY-E'],
    ['HOSP-PEDIATRIC-NW', 'HOSP-VALLEY-W'],
    ['HOSP-MERCY-E', 'HOSP-SOUTH-CH'],
    ['HUB-UNIVERSITY', 'HOSP-VALLEY-W'],
    ['HUB-UNIVERSITY', 'HOSP-SOUTH-CH']
  ];

  const INITIAL_EMERGENCIES = [
    {
      id: 'EMG-2041',
      bloodType: 'O-',
      component: 'Packed RBC (Irradiated)',
      unitsNeeded: 8,
      severity: 'critical',
      category: 'Multi-Trauma / Hemorrhage',
      needLocation: {
        nodeId: 'HOSP-TRAUMA-N',
        facility: 'Northgate Level-1 Trauma Hospital',
        ward: 'Trauma Bay 2 — OR Suite',
        zone: 'North Sector',
        address: '880 Northgate Expressway, Trauma Wing B',
        x: 260,
        y: 115
      },
      contact: {
        name: 'Dr. Marcus Vance',
        role: 'Trauma Blood Coordinator',
        phone: '+1-555-0182-404',
        email: 'trauma-blood@northgatehealth.org',
        radio: 'CH-04 / TRAUMA-NORTH'
      },
      notes: 'Active massive transfusion protocol (MTP) following highway collision; 8 units O- RBC required immediately.',
      createdAt: '2026-11-26T09:15:00+05:30',
      status: 'active'
    },
    {
      id: 'EMG-2042',
      bloodType: 'B-',
      component: 'Packed RBC',
      unitsNeeded: 5,
      severity: 'urgent',
      category: 'Obstetric Hemorrhage',
      needLocation: {
        nodeId: 'HOSP-MERCY-E',
        facility: 'Eastside Mercy Cardiac & Maternity',
        ward: 'Labor & Delivery ICU — Floor 4',
        zone: 'East Harbor',
        address: '215 Harborview Blvd, Surgical Tower 3',
        x: 805,
        y: 165
      },
      contact: {
        name: 'Elena Rostova, RN',
        role: 'Perioperative Blood Lead',
        phone: '+1-555-0166-220',
        email: 'bloodbank@eastsidemercy.org',
        radio: 'CH-07 / MERCY-EAST'
      },
      notes: 'Postpartum hemorrhage patient with anti-D antibodies; local B- reserve down to 3 units.',
      createdAt: '2026-11-26T09:28:00+05:30',
      status: 'active'
    },
    {
      id: 'EMG-2043',
      bloodType: 'A-',
      component: 'Packed RBC + Fresh Frozen Plasma',
      unitsNeeded: 6,
      severity: 'critical',
      category: 'Cardiothoracic Surgery',
      needLocation: {
        nodeId: 'HOSP-SOUTH-CH',
        facility: 'Southbay Coastal Medical Center',
        ward: 'Cardiothoracic OR-3',
        zone: 'South Coastal',
        address: '509 Coastal Pkwy, Critical Care Wing',
        x: 775,
        y: 445
      },
      contact: {
        name: 'Dr. Priya Deshmukh',
        role: 'Emergency Hematology Lead',
        phone: '+1-555-0194-305',
        email: 'stat-blood@southbaymed.org',
        radio: 'CH-15 / COAST-SOUTH'
      },
      notes: 'Emergency aortic dissection repair; A- inventory projected to exhaust within 2 hours.',
      createdAt: '2026-11-26T09:34:00+05:30',
      status: 'active'
    }
  ];

  const INITIAL_CONSUMPTION_EVENTS = [
    {
      id: 'TX-8814',
      timestamp: '2026-11-26 09:22',
      hospitalId: 'HOSP-TRAUMA-N',
      hospitalName: 'Northgate Level-1 Trauma Hospital',
      bloodType: 'O-',
      units: 4,
      department: 'Trauma Bay 1',
      category: 'Emergency Trauma / MTP',
      recordedBy: 'Dr. Marcus Vance',
      stockAfter: 5
    },
    {
      id: 'TX-8813',
      timestamp: '2026-11-26 08:48',
      hospitalId: 'HOSP-MERCY-E',
      hospitalName: 'Eastside Mercy Cardiac & Maternity',
      bloodType: 'B-',
      units: 3,
      department: 'Labor & Delivery ICU',
      category: 'Obstetric Hemorrhage',
      recordedBy: 'Elena Rostova, RN',
      stockAfter: 3
    },
    {
      id: 'TX-8812',
      timestamp: '2026-11-26 08:15',
      hospitalId: 'HOSP-SOUTH-CH',
      hospitalName: 'Southbay Coastal Medical Center',
      bloodType: 'A-',
      units: 4,
      department: 'Cardiothoracic OR-3',
      category: 'Cardiac Bypass Surgery',
      recordedBy: 'Dr. Priya Deshmukh',
      stockAfter: 4
    },
    {
      id: 'TX-8811',
      timestamp: '2026-11-26 07:40',
      hospitalId: 'HOSP-PEDIATRIC-NW',
      hospitalName: 'St. Jude Pediatric & Oncology Hospital',
      bloodType: 'A+',
      units: 3,
      department: 'Pediatric Oncology Ward 2',
      category: 'Oncology / Chemotherapy Support',
      recordedBy: 'Dr. Hannah Cho',
      stockAfter: 18
    },
    {
      id: 'TX-8810',
      timestamp: '2026-11-26 06:55',
      hospitalId: 'HOSP-METRO-NE',
      hospitalName: 'Metro General Teaching Hospital',
      bloodType: 'O+',
      units: 5,
      department: 'Surgical Block A — OR-6',
      category: 'Orthopedic Reconstruction',
      recordedBy: 'Dr. Tariq Al-Mansoor',
      stockAfter: 28
    },
    {
      id: 'TX-8809',
      timestamp: '2026-11-25 23:18',
      hospitalId: 'HOSP-VALLEY-W',
      hospitalName: 'West Valley General Hospital',
      bloodType: 'O+',
      units: 2,
      department: 'Emergency Department',
      category: 'GI Bleed Stabilization',
      recordedBy: 'David Morales',
      stockAfter: 32
    }
  ];

  global.HemoNetworkData = {
    BLOOD_TYPES: BLOOD_TYPES,
    COMPATIBLE_DONORS: COMPATIBLE_DONORS,
    EMERGENCY_LEVELS: EMERGENCY_LEVELS,
    SCENARIOS: SCENARIOS,
    EMERGENCY_DEMAND_PATTERNS: EMERGENCY_DEMAND_PATTERNS,
    HISTORY_DAY_LABELS: HISTORY_DAY_LABELS,
    INITIAL_NODES: INITIAL_NODES,
    INITIAL_LINKS: INITIAL_LINKS,
    INITIAL_EMERGENCIES: INITIAL_EMERGENCIES,
    INITIAL_CONSUMPTION_EVENTS: INITIAL_CONSUMPTION_EVENTS
  };
})(typeof window !== 'undefined' ? window : globalThis);
