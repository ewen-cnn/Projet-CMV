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
  const voltageDisplay = getEl("voltageValue");
  const injectBtn = getEl("injectBtn");

  // =========================
  // INITIALISATION GRAPHIQUES
  // =========================

  const rpmCanvas = getEl("rpmChart");
  const tempCanvas = getEl("tempChart");
  const energyCanvas = getEl("energyChart");

  let rpmChart = null;
  let tempChart = null;
  let energyChart = null;

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
            borderColor: "blue",
            fill: false,
          },
        ],
      },
    });
  }

  if (tempCanvas) {
    const tempCtx = tempCanvas.getContext("2d");

    tempChart = new Chart(tempCtx, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          { label: "T1", data: [], borderColor: "red", fill: false },
          { label: "T2", data: [], borderColor: "blue", fill: false },
          { label: "T3", data: [], borderColor: "green", fill: false },
          { label: "T eau", data: [], borderColor: "yellow", fill: false },
          { label: "T5", data: [], borderColor: "brown", fill: false },
        ],
      },
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
            label: "Énergie W",
            data: [],
            borderColor: "orange",
            fill: false,
          },
        ],
      },
    });
  }

  // =========================
  // SLIDER INJECTION COURANT
  // =========================

  if (slider && progressBar && percentDisplay && voltageDisplay) {
    slider.addEventListener("input", (e) => {
      const percent = Number(e.target.value);

      progressBar.style.width = percent + "%";
      percentDisplay.textContent = percent + "%";

      const voltage = percent * 0.12;
      voltageDisplay.textContent = voltage.toFixed(2);
    });
  }

  if (injectBtn && slider) {
    injectBtn.addEventListener("click", async () => {
      const percent = Number(slider.value);
      const voltage = percent * 0.12;

      console.log(`Injection lancée à ${percent}%`);
      console.log(`Tension envoyée : ${voltage.toFixed(2)} V`);

      try {
        await invoke("inject_current", { voltage });
      } catch (err) {
        console.error("Erreur injection courant :", err);
      }
    });
  }

  // =========================
  // MISE À JOUR LABELS
  // =========================

  function updateLabels(data) {
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
    setText("tempEauGraph", data.temp_eau.toFixed(1));
    setText("temp5Graph", data.temp5.toFixed(1));
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

  function updateCharts(data) {
    const now = new Date().toLocaleTimeString();

    if (rpmChart) {
      rpmChart.data.labels.push(now);
      rpmChart.data.datasets[0].data.push(data.rpm);

      limitChartData(rpmChart);
      rpmChart.update();
    }

    if (tempChart) {
      tempChart.data.labels.push(now);

      tempChart.data.datasets[0].data.push(data.temp1);
      tempChart.data.datasets[1].data.push(data.temp2);
      tempChart.data.datasets[2].data.push(data.temp3);
      tempChart.data.datasets[3].data.push(data.temp_eau);
      tempChart.data.datasets[4].data.push(data.temp5);

      limitChartData(tempChart);
      tempChart.update();
    }

    if (energyChart) {
      energyChart.data.labels.push(now);
      energyChart.data.datasets[0].data.push(data.energy);

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

      updateLabels(data);
      updateCharts(data);

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