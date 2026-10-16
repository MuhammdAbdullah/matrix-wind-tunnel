const WindTunnelCharts = (() => {
    const TRACE_COLORS = { lift: '#47c2ee', drag: '#f1b15a', pressure: '#b783e8', velocity: '#6fe0a3', fanSpeed: '#e8a0e0', angle: '#e8d35a' };
    const TRACE_UNITS = { lift: 'mN', drag: 'mN', pressure: 'Pa', velocity: 'm/s', fanSpeed: '%', angle: '°' };

    let liveChart = null;
    let historyChart = null;

    function baseOptions(yLabel) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'nearest', intersect: false },
            plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 10 } } } },
            scales: {
                x: { ticks: { maxTicksLimit: 8 }, grid: { color: 'rgba(130,154,170,0.12)' } },
                y: { title: { display: Boolean(yLabel), text: yLabel || '' }, grid: { color: 'rgba(130,154,170,0.12)' } }
            }
        };
    }

    function buildDatasets(traces) {
        return traces.map((trace) => ({
            label: `${trace[0].toUpperCase()}${trace.slice(1)}${TRACE_UNITS[trace] ? ` (${TRACE_UNITS[trace]})` : ''}`,
            data: [],
            borderColor: TRACE_COLORS[trace] || '#999',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25
        }));
    }

    function createCharts() {
        const liveCtx = document.getElementById('liveChart');
        const historyCtx = document.getElementById('historyChart');
        liveChart = new Chart(liveCtx, { type: 'line', data: { labels: [], datasets: [] }, options: baseOptions() });
        historyChart = new Chart(historyCtx, { type: 'line', data: { labels: [], datasets: [] }, options: baseOptions() });
    }

    function configureForExperiment(experiment) {
        const traces = experiment.liveTraces;
        liveChart.data.datasets = buildDatasets(traces);
        liveChart.data.labels = [];
        liveChart.update();
        historyChart.data.datasets = buildDatasets(traces);
        historyChart.data.labels = [];
        historyChart.update();
    }

    function updateLive(samples, experiment) {
        if (!liveChart) return;
        const traces = experiment.liveTraces;
        liveChart.data.labels = samples.map((_point, index) => index);
        traces.forEach((trace, datasetIndex) => {
            if (!liveChart.data.datasets[datasetIndex]) return;
            liveChart.data.datasets[datasetIndex].data = samples.map((point) => point[trace] ?? null);
        });
        liveChart.update();
    }

    function updateHistory(samples, experiment) {
        if (!historyChart) return;
        const traces = experiment.liveTraces;
        historyChart.data.labels = samples.map((_point, index) => index);
        traces.forEach((trace, datasetIndex) => {
            if (!historyChart.data.datasets[datasetIndex]) return;
            historyChart.data.datasets[datasetIndex].data = samples.map((point) => point[trace] ?? null);
        });
        historyChart.update();
    }

    return { createCharts, configureForExperiment, updateLive, updateHistory };
})();
