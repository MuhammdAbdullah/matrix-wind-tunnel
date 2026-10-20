const WindTunnelCharts = (() => {
    const TRACE_COLORS = { lift: '#47c2ee', drag: '#f1b15a', pressure: '#b783e8', velocity: '#6fe0a3', fanSpeed: '#e8a0e0', angle: '#e8d35a', pressureTop: '#b783e8', pressureBottom: '#e86f9b', cp: '#47c2ee', cpTop: '#47c2ee', cpBottom: '#f1b15a' };
    const TRACE_UNITS = { lift: 'mN', drag: 'mN', pressure: 'Pa', velocity: 'm/s', fanSpeed: '%', angle: '°', pressureTop: 'Pa', pressureBottom: 'Pa', cp: '', cpTop: '', cpBottom: '', time: 's' };
    const AXIS_LABELS = { time: 'Time', fanSpeed: 'Fan Speed', angle: 'Angle', lift: 'Lift', drag: 'Drag', pressure: 'Pressure', velocity: 'Velocity', cp: 'Cp', chordX: 'Fractional Chord Position', manualAngle: 'Angle of Attack' };
    const TRACE_LABELS = { pressureTop: 'Pressure (Top)', pressureBottom: 'Pressure (Bottom)', cp: 'Cp', cpTop: 'Cp (Top)', cpBottom: 'Cp (Bottom)' };
    // One color per sweep run (not per trace) so repeated sweeps stay visually distinct when
    // stacked on the history chart; traces within the same run share its color and are told
    // apart by dash style instead (solid first trace, dashed second), mirroring the legacy
    // GraphPlot mechanism's behavior of adding a new trace pair per sweep rather than
    // overwriting the previous one.
    const RUN_COLOR_PALETTE = ['#47c2ee', '#f1b15a', '#b783e8', '#6fe0a3', '#e8a0e0', '#e8d35a', '#ff6b6b', '#5ad1d1'];
    const RUN_DASH_PATTERNS = [[], [6, 3], [2, 2], [8, 3, 2, 3]];
    // Lift/drag/pressure hover near zero and are noisy, so a tight auto-scaled axis makes flat
    // readings look like wild swings. Force at least this much span on any axis showing one of
    // these traces (e.g. -100..100) so small sensor noise doesn't get visually exaggerated.
    const MIN_AXIS_SPAN = { lift: 200, drag: 200, pressure: 200, pressureTop: 200, pressureBottom: 200 };

    function minSpanForTraces(traces) {
        const span = traces.reduce((max, trace) => Math.max(max, MIN_AXIS_SPAN[trace] || 0), 0);
        return span || undefined;
    }

    function enforceMinSpan(scale) {
        const minSpan = scale.options.minSpan;
        if (!minSpan) return;
        const span = scale.max - scale.min;
        if (span < minSpan) {
            const mid = (scale.max + scale.min) / 2;
            scale.min = mid - minSpan / 2;
            scale.max = mid + minSpan / 2;
        }
    }

    let liveChart = null;
    let historyChart = null;
    let lastExperiment = null;
    let lastCustomAxes = null;

    // updateHistoryRuns() rebuilds the history chart's dataset array into brand-new objects
    // every publish (it has to, since run/point data grows each sweep tick), but Chart.js
    // matches a legend hide/show toggle to the exact dataset OBJECT it was clicked on -- so a
    // fresh object each update would forget the toggle a second later. Track hidden state by
    // label instead and reapply it (via the dataset.hidden fallback Chart.js already checks
    // when a dataset has no meta yet) whenever a run's datasets are recreated.
    const hiddenLabelsByChart = new WeakMap();

    function getHiddenLabels(chart) {
        let set = hiddenLabelsByChart.get(chart);
        if (!set) { set = new Set(); hiddenLabelsByChart.set(chart, set); }
        return set;
    }

    function themeTextColor() {
        return document.documentElement.getAttribute('data-theme') === 'light' ? '#1e293b' : '#ffffff';
    }

    function baseOptions(yLabel) {
        const textColor = themeTextColor();
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: textColor,
                        font: { size: 10 },
                        usePointStyle: true,
                        pointStyle: 'circle',
                        generateLabels(chart) {
                            const original = Chart.defaults.plugins.legend.labels.generateLabels;
                            const labels = original.call(this, chart);
                            labels.forEach((label, index) => {
                                const meta = chart.getDatasetMeta(index);
                                const isHidden = meta.hidden === true || (meta.hidden === null && chart.data.datasets[index].hidden === true);
                                label.fillStyle = isHidden ? 'transparent' : label.strokeStyle;
                            });
                            return labels;
                        }
                    },
                    onClick(e, legendItem, legend) {
                        const index = legendItem.datasetIndex;
                        const ci = legend.chart;
                        const meta = ci.getDatasetMeta(index);
                        meta.hidden = meta.hidden === null ? !ci.data.datasets[index].hidden : null;
                        ci.update();
                        const label = ci.data.datasets[index].label;
                        const hiddenLabels = getHiddenLabels(ci);
                        if (ci.isDatasetVisible(index)) hiddenLabels.delete(label);
                        else hiddenLabels.add(label);
                    }
                }
            },
            scales: {
                x: { ticks: { color: textColor, maxTicksLimit: 8 }, title: { display: false, text: '', color: textColor }, grid: { color: 'rgba(130,154,170,0.12)' } },
                y: { position: 'left', ticks: { color: textColor }, title: { display: Boolean(yLabel), text: yLabel || '', color: textColor }, grid: { color: 'rgba(130,154,170,0.12)' }, afterDataLimits: enforceMinSpan },
                y1: { position: 'right', display: false, ticks: { color: textColor }, title: { display: false }, grid: { drawOnChartArea: false }, afterDataLimits: enforceMinSpan }
            }
        };
    }

    function applyThemeColors(chart) {
        if (!chart) return;
        const textColor = themeTextColor();
        chart.options.scales.x.ticks.color = textColor;
        chart.options.scales.y.ticks.color = textColor;
        chart.options.scales.y1.ticks.color = textColor;
        if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = textColor;
        if (lastExperiment) {
            applySecondaryAxis(chart, lastExperiment);
            applyAxisLabels(chart, lastExperiment, lastCustomAxes);
        } else {
            chart.options.scales.x.title.color = textColor;
            chart.options.scales.y.title.color = textColor;
        }
        chart.update('none');
    }

    function updateTheme() {
        applyThemeColors(liveChart);
        applyThemeColors(historyChart);
    }

    function buildDatasets(traces, secondaryTraces = []) {
        return traces.map((trace) => ({
            label: TRACE_LABELS[trace] || `${trace[0].toUpperCase()}${trace.slice(1)}${TRACE_UNITS[trace] ? ` (${TRACE_UNITS[trace]})` : ''}`,
            data: [],
            borderColor: TRACE_COLORS[trace] || '#999',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
            yAxisID: secondaryTraces.includes(trace) ? 'y1' : 'y'
        }));
    }

    function customTitle(customAxes) {
        return `${AXIS_LABELS[customAxes.y] || customAxes.y} vs ${AXIS_LABELS[customAxes.x] || customAxes.x}`;
    }

    function buildCustomDataset(customAxes) {
        return [{
            label: customTitle(customAxes),
            data: [],
            borderColor: TRACE_COLORS[customAxes.y] || '#999',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3
        }];
    }

    function createCharts() {
        const liveCtx = document.getElementById('liveChart');
        const historyCtx = document.getElementById('historyChart');
        liveChart = new Chart(liveCtx, { type: 'line', data: { labels: [], datasets: [] }, options: baseOptions() });
        historyChart = new Chart(historyCtx, { type: 'line', data: { labels: [], datasets: [] }, options: baseOptions() });
    }

    function tracesFor(experiment, customAxes) {
        return experiment.id === 'custom' ? [customAxes.y] : experiment.liveTraces;
    }

    function applySecondaryAxis(chart, experiment) {
        const secondaryTraces = experiment.secondaryTraces || [];
        chart.options.scales.y1.display = secondaryTraces.length > 0;
        chart.options.scales.y1.title.display = secondaryTraces.length > 0;
        chart.options.scales.y1.title.text = secondaryTraces
            .map((trace) => `${AXIS_LABELS[trace] || trace}${TRACE_UNITS[trace] ? ` (${TRACE_UNITS[trace]})` : ''}`)
            .join(' / ');
        chart.options.scales.y1.title.color = themeTextColor();
        chart.options.scales.y1.ticks.color = themeTextColor();
    }

    function applyAxisLabels(chart, experiment, customAxes) {
        const textColor = themeTextColor();
        if (experiment.id === 'custom' && customAxes) {
            const xTrace = customAxes.x;
            const yTrace = customAxes.y;
            chart.options.scales.x.title.display = true;
            chart.options.scales.x.title.text = `${AXIS_LABELS[xTrace] || xTrace}${TRACE_UNITS[xTrace] ? ` (${TRACE_UNITS[xTrace]})` : ''}`;
            chart.options.scales.x.title.color = textColor;
            chart.options.scales.y.title.display = true;
            chart.options.scales.y.title.text = `${AXIS_LABELS[yTrace] || yTrace}${TRACE_UNITS[yTrace] ? ` (${TRACE_UNITS[yTrace]})` : ''}`;
            chart.options.scales.y.title.color = textColor;
            return;
        }
        chart.options.scales.x.title.display = Boolean(experiment.xLabel);
        chart.options.scales.x.title.text = experiment.xLabel || '';
        chart.options.scales.x.title.color = textColor;
        chart.options.scales.y.title.display = Boolean(experiment.yLabel);
        chart.options.scales.y.title.text = experiment.yLabel || '';
        chart.options.scales.y.title.color = textColor;
    }

    function configureForExperiment(experiment, customAxes) {
        lastExperiment = experiment;
        lastCustomAxes = customAxes;
        const isCustom = experiment.id === 'custom';
        const secondaryTraces = isCustom ? [] : (experiment.secondaryTraces || []);
        const primaryTraces = isCustom ? [customAxes.y] : experiment.liveTraces.filter((trace) => !secondaryTraces.includes(trace));
        const yMinSpan = minSpanForTraces(primaryTraces);
        const y1MinSpan = minSpanForTraces(secondaryTraces);

        liveChart.data.datasets = isCustom ? buildCustomDataset(customAxes) : buildDatasets(experiment.liveTraces, experiment.secondaryTraces);
        liveChart.data.labels = [];
        applySecondaryAxis(liveChart, isCustom ? {} : experiment);
        applyAxisLabels(liveChart, experiment, customAxes);
        liveChart.options.scales.y.minSpan = yMinSpan;
        liveChart.options.scales.y1.minSpan = y1MinSpan;
        liveChart.update();

        // The history chart switches to a numeric x-axis (actual angle/fan-speed/tapping-
        // channel values) for sweep-type experiments (via updateHistoryRuns()'s {x,y} series)
        // and for no-sweep experiments that declare an xField (via updateHistory() below,
        // mirroring the legacy source's FanSpeed/Angle/TappingChannel-vs-sensor XY plot).
        historyChart.options.scales.x.type = experiment.sweepType || experiment.xField || isCustom ? 'linear' : 'category';
        historyChart.data.datasets = experiment.sweepType ? [] : (isCustom ? buildCustomDataset(customAxes) : buildDatasets(experiment.liveTraces, experiment.secondaryTraces));
        historyChart.data.labels = [];
        applySecondaryAxis(historyChart, isCustom ? {} : experiment);
        applyAxisLabels(historyChart, experiment, customAxes);
        historyChart.options.scales.y.minSpan = yMinSpan;
        historyChart.options.scales.y1.minSpan = y1MinSpan;
        historyChart.update();
    }

    function formatSampleTime(point) {
        return point.time ? new Date(point.time).toLocaleTimeString([], { hour12: false }) : '';
    }

    function updateLive(samples, experiment, customAxes) {
        if (!liveChart) return;
        const traces = tracesFor(experiment, customAxes);
        liveChart.data.labels = samples.map(formatSampleTime);
        traces.forEach((trace, datasetIndex) => {
            if (!liveChart.data.datasets[datasetIndex]) return;
            liveChart.data.datasets[datasetIndex].data = samples.map((point) => point[trace] ?? null);
        });
        liveChart.update();
    }

    // custom's "Time" axis option stores main/sweeps.js's row.time as an ISO string (kept
    // readable in the CSV); a linear chart axis can't plot a string, so convert it to elapsed
    // seconds since the first point in this series instead of a raw epoch number.
    function parseTimeValue(value) {
        return typeof value === 'number' ? value : Date.parse(value);
    }

    function updateHistory(samples, experiment, customAxes) {
        if (!historyChart) return;
        const traces = tracesFor(experiment, customAxes);
        // custom's x-axis field is picked by the operator at runtime (customAxes.x), unlike
        // the other manual experiments whose xField is a fixed property in experiments.js --
        // resolve it here so the history/XY chart plots the real selected X value, matching
        // the legacy source's Chart_XY.AddPoint(.X, .Y).
        const xField = experiment.id === 'custom' ? customAxes.x : experiment.xField;
        if (xField) {
            // Numeric x-axis: plot {x,y} pairs against the experiment's real swept value
            // (fan speed / manual angle / tapping channel), matching the legacy source's
            // XY plot for this experiment instead of a plain sample-index axis.
            historyChart.data.labels = [];
            const startTime = xField === 'time' && samples.length ? parseTimeValue(samples[0].time) : null;
            traces.forEach((trace, datasetIndex) => {
                if (!historyChart.data.datasets[datasetIndex]) return;
                historyChart.data.datasets[datasetIndex].data = samples.map((point) => {
                    const x = xField === 'time' ? (parseTimeValue(point.time) - startTime) / 1000 : point[xField];
                    return { x, y: point[trace] ?? null };
                });
            });
        } else {
            historyChart.data.labels = samples.map((_point, index) => index);
            traces.forEach((trace, datasetIndex) => {
                if (!historyChart.data.datasets[datasetIndex]) return;
                historyChart.data.datasets[datasetIndex].data = samples.map((point) => point[trace] ?? null);
            });
        }
        historyChart.update();
    }

    function updateHistoryRuns(runs, experiment) {
        if (!historyChart) return;
        const traces = experiment.liveTraces || [];
        const secondaryTraces = experiment.secondaryTraces || [];
        const hiddenLabels = getHiddenLabels(historyChart);
        const datasets = [];
        runs.forEach((run, runIndex) => {
            const color = RUN_COLOR_PALETTE[runIndex % RUN_COLOR_PALETTE.length];
            traces.forEach((trace, traceIndex) => {
                const traceLabel = TRACE_LABELS[trace] || `${trace[0].toUpperCase()}${trace.slice(1)}`;
                const label = `${traceLabel} @ ${run.label}`;
                datasets.push({
                    label,
                    data: run.points.map((point) => ({ x: point.x, y: point.sensors[trace] ?? null })),
                    borderColor: color,
                    backgroundColor: 'transparent',
                    borderDash: RUN_DASH_PATTERNS[traceIndex % RUN_DASH_PATTERNS.length],
                    borderWidth: 2,
                    pointRadius: 2,
                    tension: 0.3,
                    showLine: true,
                    hidden: hiddenLabels.has(label),
                    yAxisID: secondaryTraces.includes(trace) ? 'y1' : 'y'
                });
            });
        });
        historyChart.data.datasets = datasets;
        historyChart.update();
    }

    // CP0704-Aerodynamics.pdf Worksheets 2 and 3 both ask students to hand-draw a "pressure
    // distribution diagram": arrows normal to the surface, pointing toward it for positive Cp
    // and away from it for negative Cp (suction), length proportional to |Cp|. This draws that
    // diagram automatically instead of leaving it to the student -- a circle swept by angle for
    // the Cylinder, and a straight chord line with arrows above/below for the Aerofoil (a
    // schematic simplification of the true NACA0015 profile, adequate for showing the
    // suction-peak-near-leading-edge shape the worksheet asks students to notice).
    function drawPressureDistribution(canvas, experiment, points) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const cssWidth = canvas.clientWidth || 480;
        const cssHeight = canvas.clientHeight || 320;
        canvas.width = cssWidth * dpr;
        canvas.height = cssHeight * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssWidth, cssHeight);

        const textColor = themeTextColor();
        ctx.strokeStyle = 'rgba(130,154,170,0.5)';
        ctx.fillStyle = textColor;
        ctx.font = '11px sans-serif';

        const validPoints = points.filter((point) => point.sensors && typeof point.sensors.cp === 'number');
        if (!validPoints.length) {
            ctx.fillText('No Cp data yet for this run -- log points with a pitot-static calibration available.', 12, cssHeight / 2);
            return;
        }

        function drawArrow(x1, y1, x2, y2, color) {
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            const angle = Math.atan2(y2 - y1, x2 - x1);
            const headLen = 5;
            ctx.beginPath();
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
            ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
            ctx.closePath();
            ctx.fill();
        }

        const maxAbsCp = Math.max(1, ...validPoints.map((point) => Math.abs(point.sensors.cp)));
        const scale = (value) => (Math.abs(value) / maxAbsCp) * (experiment.id === 'pressureTappedCylinder' ? 40 : 28);

        if (experiment.id === 'pressureTappedCylinder') {
            const cx = cssWidth / 2;
            const cy = cssHeight / 2;
            const radius = Math.min(cssWidth, cssHeight) / 2 - 55;
            ctx.strokeStyle = textColor;
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.stroke();
            // Flow-direction arrows upstream of the cylinder, matching the worksheet diagram.
            for (let row = -1; row <= 1; row += 1) {
                drawArrow(cx - radius - 55, cy + row * 20, cx - radius - 15, cy + row * 20, 'rgba(130,154,170,0.8)');
            }
            ctx.fillText('Air flow', cx - radius - 55, cy - 35);

            validPoints.forEach((point) => {
                const cp = point.sensors.cp;
                const thetaRad = (point.x * Math.PI) / 180;
                // theta=0 at the upstream (left) point, matching the worksheet's stagnation-point convention.
                const nx = -Math.cos(thetaRad);
                const ny = -Math.sin(thetaRad);
                const sx = cx + nx * radius;
                const sy = cy + ny * radius;
                const len = Math.max(4, scale(cp));
                const outerX = sx + nx * len;
                const outerY = sy + ny * len;
                const color = cp >= 0 ? '#f1b15a' : '#47c2ee';
                if (cp >= 0) drawArrow(outerX, outerY, sx, sy, color);
                else drawArrow(sx, sy, outerX, outerY, color);
            });
        } else {
            // Aerofoil: schematic chord line, arrows normal to it, upper points above, lower below.
            const marginX = 50;
            const chordY = cssHeight / 2;
            const chordLen = cssWidth - marginX * 2;
            ctx.strokeStyle = textColor;
            ctx.beginPath();
            ctx.moveTo(marginX, chordY);
            ctx.lineTo(marginX + chordLen, chordY);
            ctx.stroke();
            drawArrow(marginX - 35, chordY, marginX - 5, chordY, 'rgba(130,154,170,0.8)');
            ctx.fillText('Air flow', marginX - 35, chordY - 10);
            ctx.fillText('Leading edge', marginX - 10, chordY + 18);
            ctx.fillText('Trailing edge', marginX + chordLen - 35, chordY + 18);

            validPoints.forEach((point) => {
                const surface = point.sensors.surface;
                const cp = surface === 'upper' ? point.sensors.cpTop : surface === 'lower' ? point.sensors.cpBottom : point.sensors.cp;
                if (typeof cp !== 'number') return;
                const sx = marginX + point.x * chordLen;
                const dir = surface === 'lower' ? 1 : -1; // up for upper surface, down for lower
                const len = Math.max(4, scale(cp));
                const sy = chordY + dir * 6;
                const outerY = sy + dir * len;
                const color = cp >= 0 ? '#f1b15a' : '#47c2ee';
                if (cp >= 0) drawArrow(sx, outerY, sx, sy, color);
                else drawArrow(sx, sy, sx, outerY, color);
            });
        }

        ctx.fillStyle = textColor;
        ctx.fillText(`Orange = positive Cp (toward surface)   Blue = negative Cp / suction (away from surface)   max|Cp| = ${maxAbsCp.toFixed(2)}`, 12, cssHeight - 10);
    }

    return { createCharts, configureForExperiment, updateLive, updateHistory, updateHistoryRuns, customTitle, updateTheme, drawPressureDistribution };
})();
