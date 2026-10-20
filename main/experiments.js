// Raw passthrough only: lift/drag/pressure/velocity are the hardware's floats as-is.
// The Flowcode source has no coefficient formula (no rho/area/0.5*v^2 anywhere) and no
// per-drag-shape correction factor -- "dragShape" and "tapping" fields below are metadata
// written to the CSV/UI label only, never consumed in a calculation. Pressure Tapped Cylinder
// and Pressure Tapped Aerofoil likewise plot the raw pressure (Pa) -- the legacy source computes
// no pressure coefficient and needs no pitot-static calibration for either.
// "manualAngle" (Cylinder) is just the Increment Angle setting: the legacy source reads the
// one shared angle gauge, logs it, and bumps the gauge by that increment (wrap +180 -> -180).
// Per the legacy source's own per-experiment property-visibility switch (confirmed at two
// independent places: the "DragShapeCat" property-folder visibility toggle and the CSV
// header-writing switch), the drag-shape selector belongs ONLY to Drag Coefficient -- Lift
// Coefficient never shows or logs a drag shape. Its "Increment Speed" sibling property,
// though filed under the same property folder, is read by the OnLogButtonClick macro's
// Exercise 0 case too (Wind Tunnel Control.fcsx:1528, same shared IncrementSpeed variable as
// Exercise 4's :1722) -- Convert Pressure to Velocity and Drag Coefficient both auto-advance
// the real fan speed by it once per logged point (wrapping 100 -> 0), so both declare the
// 'fanSpeedIncrement' field here.
//
// manualLog: true marks the experiments whose chart/CSV point comes from a single click of
// the legacy "Log" button (OnLogButtonClick), not the continuous per-tick sensor-sample timer
// -- confirmed by the source's own timer wiring: timer 6 (the sensor-sample timer) only calls
// OnLogButtonClick automatically when Exercise = 6 (Sensors vs Time); every other no-sweep
// experiment's Exercise case in that same macro is reached only via a manual button click,
// which also plots unconditionally (a CSV row is written only if a log file is open) and then
// auto-advances fan speed / manual angle / tapping channel for the next click. sensorsVsTime
// is the one no-sweep experiment that stays continuous.
const DRAG_SHAPES = ['Flat Surface', 'Cone', 'Tear Drop', 'Rough Ball', 'Semi Sphere', 'Smooth Ball'];

// Legacy OnLogButtonClick Exercise 2 X value: channel 1 plots at 0 on both traces, upper
// channels 2-12 at channel-1, lower channels 13-23 at channel-12.
function tappingXFor(channel) {
    const ch = Math.min(23, Math.max(1, Number(channel) || 1));
    if (ch === 1) return 0;
    return ch <= 12 ? ch - 1 : ch - 12;
}

const EXPERIMENTS = [
    {
        id: 'pressureToVelocity',
        title: 'Convert Pressure to Velocity',
        sweepType: null,
        manualLog: true,
        liveTraces: ['pressure'],
        fields: ['fanSpeedIncrement'],
        csvColumns: ['time', 'fanSpeed', 'pressure', 'velocity'],
        xField: 'fanSpeed',
        xLabel: 'Fan Speed (%)',
        yLabel: 'Pressure (Pa)'
    },
    {
        id: 'pressureTappedCylinder',
        title: 'Pressure Tapped Cylinder',
        sweepType: null,
        manualLog: true,
        liveTraces: ['pressure'],
        fields: ['manualAngle'],
        csvColumns: ['time', 'fanSpeed', 'angle', 'pressure'],
        xField: 'angle',
        xLabel: 'Angle of Attack (°)',
        yLabel: 'Pressure (Pa)'
    },
    {
        id: 'pressureTappedAerofoil',
        title: 'Pressure Tapped Aerofoil',
        sweepType: null,
        manualLog: true,
        liveTraces: ['pressureTop', 'pressureBottom'],
        fields: ['tapping'],
        csvColumns: ['time', 'fanSpeed', 'aerofoilAngle', 'tappingChannel', 'pressure'],
        // Legacy plots against tapping position along each surface (see tappingXFor), not chord fraction.
        xField: 'tappingX',
        xLabel: 'Tapping Position',
        yLabel: 'Pressure (Pa)'
    },
    {
        id: 'liftCoefficient',
        title: 'Lift Coefficient',
        sweepType: 'angle',
        liveTraces: ['lift', 'drag'],
        fields: [],
        csvColumns: ['time', 'angle', 'lift', 'drag'],
        xLabel: 'Angle (°)',
        yLabel: 'Lift / Drag (mN)'
    },
    {
        id: 'dragCoefficient',
        title: 'Drag Coefficient',
        sweepType: null,
        manualLog: true,
        liveTraces: ['drag'],
        fields: ['dragShape', 'fanSpeedIncrement'],
        csvColumns: ['time', 'fanSpeed', 'drag', 'dragShape'],
        xField: 'fanSpeed',
        xLabel: 'Fan Speed (%)',
        yLabel: 'Drag (mN)'
    },
    {
        id: 'stemRacing',
        title: 'Stem Racing',
        sweepType: 'fan',
        liveTraces: ['lift', 'drag'],
        fields: ['stemRacingChartType'],
        csvColumns: ['time', 'fanSpeed', 'lift', 'drag'],
        // The sweep itself always drives fan speed -- "Chart Type" (stemRacingChartType) is
        // a display-only relabelling the legacy source offers (vs Time / Air Speed / Fan
        // Speed) that isn't wired to an alternate X value here; the history chart's actual
        // x-axis is always the real swept fan-speed value.
        xLabel: 'Fan Speed (%)',
        yLabel: 'Lift / Drag (mN)'
    },
    {
        id: 'sensorsVsTime',
        title: 'Sensors vs Time',
        sweepType: null,
        liveTraces: ['lift', 'drag', 'pressure'],
        secondaryTraces: ['pressure'],
        fields: ['traceVisibility'],
        csvColumns: ['time', 'fanSpeed', 'lift', 'drag', 'pressure'],
        xLabel: 'Time (s)',
        yLabel: 'Lift / Drag (mN)'
    },
    {
        id: 'custom',
        title: 'Custom',
        sweepType: null,
        manualLog: true,
        liveTraces: ['lift', 'drag', 'pressure', 'velocity', 'fanSpeed', 'angle'],
        fields: ['customAxes'],
        csvColumns: ['time', 'customX', 'customY']
    }
];

const SWEEP_DEFAULTS = {
    angle: { start: -20, end: 45, step: 5, delay: 5000 },
    fan: { start: 0, end: 60, step: 10, delay: 5000 }
};

function getById(id) {
    return EXPERIMENTS.find((experiment) => experiment.id === id) || EXPERIMENTS[0];
}

module.exports = { EXPERIMENTS, DRAG_SHAPES, SWEEP_DEFAULTS, tappingXFor, getById };
