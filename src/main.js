// =========================
// TAURI
// =========================
const { invoke } = window.__TAURI__.core;

document.addEventListener("DOMContentLoaded", () => {
  // =========================
  // HELPERS DOM
  // =========================

  function getEl(id) {
    const el = document.getElementById(id);

    if (!el) {
      console.warn(`Élément introuvable : #${id}`);
    }

    return el;
  }

  function getOptionalEl(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const el = getEl(id);
    if (el) {
      el.textContent = value;
    }
  }

  // =========================
  // ÉLÉMENTS INJECTION COURANT
  // =========================

  const slider = getEl("injectionSlider");
  const progressBar = getEl("progress-bar");
  const percentDisplay = getEl("progress-percent");
  const voltageDisplay = getOptionalEl("voltageValue");
  const readoutRing = document.querySelector(".readout-ring");
  const percentInput = getOptionalEl("percentInput");
  const voltageInput = getOptionalEl("voltageInput");
  const stepInput = getOptionalEl("stepInput");
  const decreaseInjectionBtn = getOptionalEl("decreaseInjectionBtn");
  const increaseInjectionBtn = getOptionalEl("increaseInjectionBtn");
  const zeroInjectionBtn = getEl("zeroInjectionBtn");
  const injectionStatus = getEl("injectionStatus");
  const injectBtn = getEl("injectBtn");
  const presetButtons = document.querySelectorAll(".preset-button");
  const MAX_INJECTION_VOLTAGE = 5;

  let currentInjectionPercent = 0;

  // =========================
  // INITIALISATION GRAPHIQUES
  // =========================

  const rpmCanvas = getEl("rpmChart");
  const tempCanvas = getEl("tempChart");
  const energyCanvas = getEl("energyChart");

  let rpmChart = null;
  let tempChart = null;
  let energyChart = null;

  const chartStartedAt = Date.now();
  const CHART_LIMITS = {
    rpm: { yMin: 0, yMax: 2500, yStep: 500 },
    temp: { yMin: 0, yMax: 90, yStep: 10 },
    energy: { yMin: 0, yMax: 300, yStep: 50 },
  };
  const SMA_PARAMS = {
    pulleyRadiusM: 70e-3,
    wireLengthM: 0.4,
    wireDiameterM: 0.1e-3,
    densityKgM3: 1190,
    specificHeatJKgK: 460,
    phaseEnthalpyJKg: 325,
    martensiteStartK: 307,
    martensiteFinishK: 294,
    austeniteStartK: 310,
    austeniteFinishK: 333,
    elasticAustenitePa: 40e9,
    elasticMartensitePa: 30e9,
    maxTransformationStrain: 0.04,
    water: {
      densityKgM3: 965,
      dynamicViscosityPaS: 3.2e-4,
      conductivityWMK: 0.67,
      specificHeatJKgK: 4180,
    },
    air: {
      densityKgM3: 1.2,
      dynamicViscosityPaS: 1.8e-5,
      conductivityWMK: 0.026,
      specificHeatJKgK: 1005,
    },
  };
  const DEFAULT_AIR_TEMP_C = 22;
  const DEFAULT_SOURCE_TEMP_C = 35;
  const MISSING_SENSOR_THRESHOLD_C = 0.1;
  const TRACKED_WIRE_RESPONSE_TIME_S = 1.8;
  const TEMPERATURE_SENSOR_POINTS = [
    { key: "temp1", label: "T1", position: 0 },
    { key: "temp2", label: "T2", position: 0.2 },
    { key: "temp3", label: "T3", position: 0.4 },
    { key: "temp_eau", label: "T4", position: 0.6 },
    { key: "temp5", label: "T5", position: 0.8 },
  ];

  let smaTheoryState = {
    lastElapsedSeconds: null,
    temperatureK: null,
  };
  let trackedWirePointState = {
    lastElapsedSeconds: null,
    position: 0,
    temperatureC: null,
    targetTemperatureC: null,
  };

  function getElapsedSeconds() {
    return (Date.now() - chartStartedAt) / 1000;
  }

  function createChartOptions({ yMin, yMax, yStep }) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: {
        legend: {
          labels: {
            color: "#334155",
            boxWidth: 12,
            usePointStyle: true,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: "#64748b", maxRotation: 0, maxTicksLimit: 6 },
          grid: { color: "rgba(148, 163, 184, 0.22)" },
        },
        y: {
          min: yMin,
          max: yMax,
          ticks: { color: "#64748b", stepSize: yStep },
          grid: { color: "rgba(148, 163, 184, 0.28)" },
        },
      },
    };
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function celsiusToKelvin(value) {
    return value + 273.15;
  }

  function kelvinToCelsius(value) {
    return value - 273.15;
  }

  function toFiniteNumber(value, fallback = 0) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
  }

  function formatPercent(value) {
    return Number(value.toFixed(1)).toString();
  }

  function percentToVoltage(percent) {
    return (percent / 100) * MAX_INJECTION_VOLTAGE;
  }

  function voltageToPercent(voltage) {
    return (voltage / MAX_INJECTION_VOLTAGE) * 100;
  }

  function average(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function getAvailableTemperatures(values) {
    return values
      .map((value) => Number(value))
      .filter(
        (value) =>
          Number.isFinite(value) && Math.abs(value) > MISSING_SENSOR_THRESHOLD_C
      );
  }

  function getWireTemperatures(data) {
    const temperatures = getAvailableTemperatures([
      data.temp1,
      data.temp2,
      data.temp3,
      data.temp5,
    ]);

    return temperatures.length > 0 ? temperatures : [DEFAULT_AIR_TEMP_C];
  }

  function normalizeCyclePosition(value) {
    return ((value % 1) + 1) % 1;
  }

  function getCycleDistance(from, to) {
    return normalizeCyclePosition(to - from);
  }

  function getValidTemperatureSensorPoints(data) {
    return TEMPERATURE_SENSOR_POINTS
      .map((sensor) => ({
        ...sensor,
        value: Number(data[sensor.key]),
      }))
      .filter(
        (sensor) =>
          Number.isFinite(sensor.value) &&
          Math.abs(sensor.value) > MISSING_SENSOR_THRESHOLD_C
      )
      .sort((a, b) => a.position - b.position);
  }

  function getLastPassedSensorPoint(sensorPoints, startPosition, cycleProgress) {
    if (sensorPoints.length === 0 || cycleProgress <= 0) {
      return null;
    }

    const tolerance = 1e-9;
    let lastPassedSensor = null;
    let lastPassedDistance = -Infinity;

    sensorPoints.forEach((sensor) => {
      let passDistance = getCycleDistance(startPosition, sensor.position);

      if (passDistance <= tolerance) {
        passDistance = 1;
      }

      while (passDistance <= cycleProgress + tolerance) {
        if (passDistance >= lastPassedDistance) {
          lastPassedSensor = sensor;
          lastPassedDistance = passDistance;
        }

        passDistance += 1;
      }
    });

    return lastPassedSensor;
  }

  function updateTrackedWirePointTemperature(data, elapsedSeconds) {
    const sensorPoints = getValidTemperatureSensorPoints(data);

    if (!Number.isFinite(trackedWirePointState.temperatureC)) {
      trackedWirePointState.temperatureC =
        sensorPoints[0]?.value ?? DEFAULT_AIR_TEMP_C;
    }

    if (!Number.isFinite(trackedWirePointState.targetTemperatureC)) {
      trackedWirePointState.targetTemperatureC =
        trackedWirePointState.temperatureC;
    }

    const previousElapsedSeconds =
      trackedWirePointState.lastElapsedSeconds ?? elapsedSeconds;
    const dtS = clamp(elapsedSeconds - previousElapsedSeconds, 0, 3);
    const previousPosition = trackedWirePointState.position;
    const omegaRadS = (Math.max(data.rpm, 0) * 2 * Math.PI) / 60;
    const wireSpeedMS = omegaRadS * SMA_PARAMS.pulleyRadiusM;
    const cycleProgress =
      SMA_PARAMS.wireLengthM > 0
        ? (wireSpeedMS * dtS) / SMA_PARAMS.wireLengthM
        : 0;

    trackedWirePointState.position = normalizeCyclePosition(
      previousPosition + cycleProgress
    );
    trackedWirePointState.lastElapsedSeconds = elapsedSeconds;

    const lastPassedSensor = getLastPassedSensorPoint(
      sensorPoints,
      previousPosition,
      cycleProgress
    );

    if (lastPassedSensor) {
      trackedWirePointState.targetTemperatureC = lastPassedSensor.value;
    }

    trackedWirePointState.temperatureC +=
      (trackedWirePointState.targetTemperatureC -
        trackedWirePointState.temperatureC) *
      (1 - Math.exp(-dtS / TRACKED_WIRE_RESPONSE_TIME_S));

    return trackedWirePointState.temperatureC;
  }

  function getThermalBoundsC(data, wireTemperaturesC) {
    const sourceTemperatures = getAvailableTemperatures([data.temp_eau]);
    const sourceTempC =
      sourceTemperatures[0] ??
      Math.max(DEFAULT_SOURCE_TEMP_C, ...wireTemperaturesC);
    const sinkTempC = Math.min(DEFAULT_AIR_TEMP_C, ...wireTemperaturesC);

    return { sourceTempC, sinkTempC };
  }

  function smoothStep(value) {
    const x = clamp(value, 0, 1);
    return x * x * (3 - 2 * x);
  }

  function calculateNusseltNumber(fluid, speedMS) {
    const re =
      (fluid.densityKgM3 * speedMS * SMA_PARAMS.wireDiameterM) /
      fluid.dynamicViscosityPaS;
    const pr =
      (fluid.specificHeatJKgK * fluid.dynamicViscosityPaS) /
      fluid.conductivityWMK;

    return 0.023 * Math.pow(Math.max(re, 1), 0.8) * Math.pow(pr, 0.3);
  }

  function calculateThermalTimeConstants(data) {
    const omega = (Math.max(data.rpm, 0) * 2 * Math.PI) / 60;
    const wireSpeedMS = clamp(omega * SMA_PARAMS.pulleyRadiusM, 0.05, 0.8);
    const waterNu = calculateNusseltNumber(SMA_PARAMS.water, wireSpeedMS);
    const airNu = calculateNusseltNumber(SMA_PARAMS.air, wireSpeedMS);
    const hw = (waterNu * SMA_PARAMS.water.conductivityWMK) / SMA_PARAMS.wireDiameterM;
    const ha = (airNu * SMA_PARAMS.air.conductivityWMK) / SMA_PARAMS.wireDiameterM;
    const thermalMass =
      (SMA_PARAMS.wireDiameterM / 2) *
      SMA_PARAMS.densityKgM3 *
      SMA_PARAMS.specificHeatJKgK;

    return {
      tauHeatS: clamp(thermalMass / (2 * hw), 0.8, 20),
      tauCoolS: clamp(thermalMass / (2 * ha), 4, 80),
    };
  }

  function estimateCycleTiming(timeConstants) {
    return {
      heatS: Math.max(1.2, timeConstants.tauHeatS * 1.8),
      coolS: Math.max(5, timeConstants.tauCoolS * 2.1),
    };
  }

  function calculateAusteniteFraction(temperatureK, isHeating) {
    if (isHeating) {
      return smoothStep(
        (temperatureK - SMA_PARAMS.austeniteStartK) /
          (SMA_PARAMS.austeniteFinishK - SMA_PARAMS.austeniteStartK)
      );
    }

    return smoothStep(
      (temperatureK - SMA_PARAMS.martensiteFinishK) /
        (SMA_PARAMS.martensiteStartK - SMA_PARAMS.martensiteFinishK)
    );
  }

  function updateSmaTheory(data, elapsedSeconds) {
    const wireTemperaturesC = getWireTemperatures(data);
    const measuredWireTempC = average(wireTemperaturesC);
    const trackedWireTempC = updateTrackedWirePointTemperature(
      data,
      elapsedSeconds
    );
    const { sourceTempC, sinkTempC } = getThermalBoundsC(
      data,
      wireTemperaturesC
    );
    const sourceTempK = celsiusToKelvin(sourceTempC);
    const sinkTempK = celsiusToKelvin(sinkTempC);
    const timeConstants = calculateThermalTimeConstants(data);
    const cycleTiming = estimateCycleTiming(timeConstants);
    const cycleDurationS = cycleTiming.heatS + cycleTiming.coolS;
    const cycleTimeS = elapsedSeconds % cycleDurationS;
    const isHeating = cycleTimeS <= cycleTiming.heatS;
    const targetTempK = isHeating ? sourceTempK : sinkTempK;
    const tauS = isHeating ? timeConstants.tauHeatS : timeConstants.tauCoolS;
    const previousElapsedSeconds =
      smaTheoryState.lastElapsedSeconds ?? elapsedSeconds;
    const dtS = clamp(elapsedSeconds - previousElapsedSeconds, 0.1, 3);

    if (!Number.isFinite(smaTheoryState.temperatureK)) {
      smaTheoryState.temperatureK = celsiusToKelvin(measuredWireTempC);
    }

    smaTheoryState.temperatureK +=
      (targetTempK - smaTheoryState.temperatureK) *
      (1 - Math.exp(-dtS / tauS));
    smaTheoryState.temperatureK = clamp(
      smaTheoryState.temperatureK,
      Math.min(sourceTempK, sinkTempK) - 5,
      Math.max(sourceTempK, sinkTempK) + 5
    );
    smaTheoryState.lastElapsedSeconds = elapsedSeconds;

    const austeniteFraction = calculateAusteniteFraction(
      smaTheoryState.temperatureK,
      isHeating
    );
    const martensiteFraction = 1 - austeniteFraction;
    const elasticModulusPa =
      SMA_PARAMS.elasticMartensitePa +
      (SMA_PARAMS.elasticAustenitePa - SMA_PARAMS.elasticMartensitePa) *
        austeniteFraction;
    const wireAreaM2 = (Math.PI * Math.pow(SMA_PARAMS.wireDiameterM, 2)) / 4;
    const activeStrain =
      SMA_PARAMS.maxTransformationStrain * austeniteFraction;
    const forceN = elasticModulusPa * activeStrain * wireAreaM2;
    const torqueNm = forceN * SMA_PARAMS.pulleyRadiusM;
    const omegaRadS = (Math.max(data.rpm, 0) * 2 * Math.PI) / 60;
    const powerW = torqueNm * omegaRadS;
    const thermalEfficiencyPct =
      sourceTempK > sinkTempK
        ? clamp((1 - sinkTempK / sourceTempK) * 100, 0, 100)
        : 0;

    return {
      temperatureC: kelvinToCelsius(smaTheoryState.temperatureK),
      measuredWireTempC,
      trackedWireTempC,
      sourceTempC,
      sinkTempC,
      isHeating,
      austeniteFraction,
      martensiteFraction,
      elasticModulusGPa: elasticModulusPa / 1e9,
      forceN,
      torqueNm,
      powerW,
      thermalEfficiencyPct,
    };
  }

  function getStepPercent() {
    return clamp(toFiniteNumber(stepInput?.value, 5), 0.1, 25);
  }

  function setInjectionStatus(message, state = "idle") {
    if (!injectionStatus) return;

    injectionStatus.textContent = message;
    injectionStatus.dataset.state = state;
  }

  function updatePresetState(percent) {
    presetButtons.forEach((button) => {
      const preset = toFiniteNumber(button.dataset.preset);
      button.classList.toggle("is-active", Math.abs(preset - percent) < 0.25);
    });
  }

  function syncInjectionControls(percent) {
    const safePercent = clamp(toFiniteNumber(percent), 0, 100);
    const voltage = percentToVoltage(safePercent);
    const formattedPercent = formatPercent(safePercent);

    currentInjectionPercent = safePercent;

    if (slider) slider.value = formattedPercent;
    if (progressBar) progressBar.style.width = `${safePercent}%`;
    if (readoutRing) readoutRing.style.setProperty("--charge", `${safePercent}%`);
    if (percentDisplay) percentDisplay.textContent = `${formattedPercent}%`;
    if (voltageDisplay) voltageDisplay.textContent = voltage.toFixed(2);

    if (percentInput && document.activeElement !== percentInput) {
      percentInput.value = formattedPercent;
    }

    if (voltageInput && document.activeElement !== voltageInput) {
      voltageInput.value = voltage.toFixed(2);
    }

    updatePresetState(safePercent);

    return { percent: safePercent, voltage };
  }

  if (rpmCanvas) {
    const rpmCtx = rpmCanvas.getContext("2d");

    rpmChart = new Chart(rpmCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "RPM",
            data: [],
            borderColor: "#38bdf8",
            tension: 0.28,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: createChartOptions(CHART_LIMITS.rpm),
    });
  }

  if (tempCanvas) {
    const tempCtx = tempCanvas.getContext("2d");

    tempChart = new Chart(tempCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "T fil suivie",
            data: [],
            borderColor: "#ef4444",
            tension: 0.28,
            pointRadius: 0,
            fill: false,
          },
          {
            label: "T théorique",
            data: [],
            borderColor: "#0f172a",
            borderDash: [7, 5],
            borderWidth: 2,
            tension: 0.28,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: createChartOptions(CHART_LIMITS.temp),
    });
  }

  if (energyCanvas) {
    const energyCtx = energyCanvas.getContext("2d");

    energyChart = new Chart(energyCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Puissance expérimentale",
            data: [],
            borderColor: "#f59e0b",
            tension: 0.28,
            pointRadius: 0,
            fill: false,
          },
          {
            label: "Puissance théorique SMA",
            data: [],
            borderColor: "#22c55e",
            borderDash: [6, 4],
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: createChartOptions(CHART_LIMITS.energy),
    });
  }

  // =========================
  // COMMANDE INJECTION COURANT
  // =========================

  function setInjectionButtonsDisabled(isDisabled) {
    [injectBtn, zeroInjectionBtn].forEach((button) => {
      if (button) button.disabled = isDisabled;
    });
  }

  async function sendInjection(percent = currentInjectionPercent) {
    const command = syncInjectionControls(percent);

    console.log(`Injection lancée à ${formatPercent(command.percent)}%`);
    console.log(`Tension envoyée : ${command.voltage.toFixed(2)} V`);

    setInjectionButtonsDisabled(true);
    setInjectionStatus("Envoi", "pending");

    try {
      await invoke("set_pwm", { duty: command.percent });
      setInjectionStatus("Appliqué", "success");
    } catch (err) {
      setInjectionStatus("Erreur", "error");
      console.error("Erreur injection courant :", err);
    } finally {
      setInjectionButtonsDisabled(false);
    }
  }

  if (slider) {
    slider.addEventListener("input", (e) => {
      syncInjectionControls(e.target.value);
      setInjectionStatus("Réglage");
    });
  }

  if (percentInput) {
    percentInput.addEventListener("input", (e) => {
      syncInjectionControls(e.target.value);
      setInjectionStatus("Réglage");
    });

    percentInput.addEventListener("blur", () => {
      syncInjectionControls(currentInjectionPercent);
    });
  }

  if (voltageInput) {
    voltageInput.addEventListener("input", (e) => {
      syncInjectionControls(voltageToPercent(e.target.value));
      setInjectionStatus("Réglage");
    });

    voltageInput.addEventListener("blur", () => {
      syncInjectionControls(currentInjectionPercent);
    });
  }

  if (stepInput) {
    stepInput.addEventListener("blur", () => {
      stepInput.value = getStepPercent().toString();
    });
  }

  if (decreaseInjectionBtn) {
    decreaseInjectionBtn.addEventListener("click", () => {
      syncInjectionControls(currentInjectionPercent - getStepPercent());
      setInjectionStatus("Réglage");
    });
  }

  if (increaseInjectionBtn) {
    increaseInjectionBtn.addEventListener("click", () => {
      syncInjectionControls(currentInjectionPercent + getStepPercent());
      setInjectionStatus("Réglage");
    });
  }

  presetButtons.forEach((button) => {
    button.addEventListener("click", () => {
      syncInjectionControls(button.dataset.preset);
      setInjectionStatus("Réglage");
    });
  });

  if (zeroInjectionBtn) {
    zeroInjectionBtn.addEventListener("click", () => {
      sendInjection(0);
    });
  }

  if (injectBtn) {
    injectBtn.addEventListener("click", () => {
      sendInjection();
    });
  }

  syncInjectionControls(0);

  // =========================
  // MISE À JOUR LABELS
  // =========================

  function updateLabels(data, theory) {
    console.log("updateLabels reçoit :", data);
    const rpm = data.rpm.toFixed(0);
    const energy = data.energy.toFixed(1);

    // Dashboard
    setText("rpmValueDashboard", rpm);
    setText("energyValueDashboard", energy);

    setText("val_t1", data.temp1.toFixed(1) + " °C");
    setText("val_t2", data.temp2.toFixed(1) + " °C");
    setText("val_t3", data.temp3.toFixed(1) + " °C");
    setText("val_t4", data.temp_eau.toFixed(1) + " °C");
    setText("val_t5", data.temp5.toFixed(1) + " °C");

    // Vue graphiques
    setText("rpmValueGraph", rpm);
    setText("energyValueGraph", energy);

    setText("temp1Graph", data.temp1.toFixed(1));
    setText("temp2Graph", data.temp2.toFixed(1));
    setText("temp3Graph", data.temp3.toFixed(1));
    setText("temp4Graph", data.temp_eau.toFixed(1));
    setText("temp5Graph", data.temp5.toFixed(1));
    setText("wireTempGraph", theory.trackedWireTempC.toFixed(1));
    setText("tempTheoreticalGraph", theory.temperatureC.toFixed(1));
    setText("modelTempGraph", theory.temperatureC.toFixed(1));
    setText(
      "modelPhaseGraph",
      (theory.austeniteFraction * 100).toFixed(0) + "%"
    );
    setText("modelModulusGraph", theory.elasticModulusGPa.toFixed(1));
    setText("modelForceGraph", theory.forceN.toFixed(2));
    setText("modelPowerGraph", theory.powerW.toFixed(1));
    setText(
      "modelEfficiencyGraph",
      theory.thermalEfficiencyPct.toFixed(0) + "%"
    );
  }

  // =========================
  // LIMITATION DES POINTS
  // =========================

  function limitChartData(chart, maxPoints = 60) {
    if (!chart) return;

    if (chart.data.labels.length > maxPoints) {
      chart.data.labels.shift();

      chart.data.datasets.forEach((dataset) => {
        dataset.data.shift();
      });
    }
  }

  // =========================
  // MISE À JOUR GRAPHIQUES
  // =========================

  function updateCharts(data, theory) {
    const now = new Date().toLocaleTimeString();

    if (rpmChart) {
      rpmChart.data.labels.push(now);
      rpmChart.data.datasets[0].data.push(data.rpm);

      limitChartData(rpmChart);
      rpmChart.update();
    }

    if (tempChart) {
      tempChart.data.labels.push(now);

      tempChart.data.datasets[0].data.push(theory.trackedWireTempC);
      tempChart.data.datasets[1].data.push(theory.temperatureC);

      limitChartData(tempChart);
      tempChart.update();
    }

    if (energyChart) {
      energyChart.data.labels.push(now);
      energyChart.data.datasets[0].data.push(data.energy);
      energyChart.data.datasets[1].data.push(theory.powerW);

      limitChartData(energyChart);
      energyChart.update();
    }
  }

  // =========================
  // FETCH DATA DEPUIS RUST
  // =========================

  async function fetchData() {
    try {
      const data = await invoke("get_sensor_data");
      const elapsedSeconds = getElapsedSeconds();
      const theory = updateSmaTheory(data, elapsedSeconds);

      console.log("Data reçue de Rust :", data);
      updateLabels(data, theory);
      updateCharts(data, theory);

    } catch (err) {
      console.error("Erreur récupération capteurs :", err);
    }
  }

  // Première lecture immédiate
  fetchData();

  // Mise à jour toutes les 1s
  setInterval(fetchData, 1000);

  // Test communication Rust
  testTauri();
});

// =========================
// TEST RUST
// =========================

async function testTauri() {
  try {
    const res = await invoke("get_sensor_data");
    console.log("Données Rust :", res);
  } catch (err) {
    console.error("Erreur Rust :", err);
  }
}
