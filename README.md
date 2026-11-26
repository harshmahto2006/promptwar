# HemoPulse — Multi-Hospital Predictive Emergency Blood Shortage Platform

HemoPulse is an interactive, zero-dependency **Multi-Hospital Predictive Emergency Blood Shortage Platform** designed for regional blood banks, multi-hospital networks, and emergency dispatch coordinators. It combines **7-day consumption history**, **predictive shortage forecasting**, and **emergency routing** across **Blood Type**, **Emergency Severity**, **Need Location**, and **24/7 Contact**.

## Key Capabilities

1. **Multi-Hospital Platform & Portal Switching (`js/network-data.js`, `js/app.js`)**
   - Connects **6 specialized hospitals** (*Northgate Level-1 Trauma*, *Eastside Mercy Cardiac & Maternity*, *West Valley General*, *Southbay Coastal Medical Center*, *St. Jude Pediatric & Oncology*, *Metro General Teaching Hospital*) and **2 Regional Blood Hubs** (*Central Metro Blood Bank*, *University Hematology & Reserve*).
   - Switch between **All Hospitals — Regional Command** and any individual **Hospital Workspace Portal**, or onboard additional facilities with **+ Add Hospital**.

2. **Consumption History & Empirical Burn Calibration (`js/prediction-engine.js`)**
   - Tracks 7-day daily transfusion history per hospital and blood type plus a live **Consumption History Ledger** (`department`, `category`, `recordedBy`, `stockAfter`).
   - `computeHistoricalBurnMetrics` weights recent 48h utilization and 7-day rolling averages to compute empirical hourly burn velocity and trend momentum (`+Δ%`).
   - **+ Log Consumption** deducts transfused units from inventory, updates today's consumption bucket, and immediately recalibrates shortage trajectories.

3. **Emergency Demand Patterns & Surge Modeling (`EMERGENCY_DEMAND_PATTERNS`)**
   - Models 6 clinical surge patterns (*Steady Clinical Baseline*, *Weekend Highway Trauma Surge*, *Obstetric & Maternal Hemorrhage Pulse*, *Seasonal Outbreak / Dengue & Oncology Wave*, *Mass Casualty Incident Shockwave*, and *Pediatric & Thalassemia Clinic Cycle*) plus **+ Custom Demand Pattern**.
   - `computeDemandPatternFactor` and `analyzeEmergencyDemandPatterns` compute blood-type affinity, hospital-tier exposure, and temporal wave shapes (`impulse_decay`, `nocturnal_trauma_wave`, `daytime_clinic_wave`, `sustained_plateau`), updating shortage trajectories and comparing hourly demand curves.

4. **Visual Analytics Suite (`#visualizationsPanel`)**
   - **Blood Type Supply vs. Projected Demand (`#bloodBalanceSvg`)**: Grouped bar visualization comparing on-hand reserves against horizon demand across all 8 ABO/Rh blood types.
   - **Multi-Hospital Stock & Urgency Comparison (`#hospitalCompareSvg`)**: Ranked horizontal bar comparison across hospitals showing stock, active emergency request pressure, and risk score.
   - **ABO/Rh Compatibility & Donor Flow Graph (`#compatFlowSvg`)**: Bipartite donor-to-recipient transfusion path visualization with live unit availability and at-risk counts.

5. **Predictive Shortage & Optimal Dispatch Engine**
   - Forecasts inventory trajectories over **12h, 24h, 48h, or 72h** with diurnal surgical/trauma cycles, active emergency shockwaves, replenishment inflow, expiry decay, and confidence bands.
   - Evaluates **Blood Type** (all 8 ABO/Rh types + RBC compatibility fallback), **Emergency** severity (`Code Red`, `Code Amber`, `Watch`, `Routine`), **Need Location** (facility, ward, zone, address, map pins), and **Contact** (`tel:`, `mailto:`, radio channel, clipboard copy).

## Running Locally & Tests

- Open `index.html` in any modern web browser.
- Open `tests/test-runner.html` to run the automated test suite.
