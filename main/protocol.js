const CMD = {
    VERSION: 'A',
    FAN_SPEED: 'B',
    READ_SENSORS: 'C',
    ANGLE: 'D',
    LED: 'E',
    ZERO_SENSORS: 'F',
    ZERO_MOTOR: 'G',
    SET_SCALER: 'H',
    GET_SCALERS: 'I',
    SET_LUT: 'J',
    GET_LUT: 'K',
    CALIBRATE_DISPLAY: 'L',
    SET_NETWORK: 'M'
};

const START_MARKER = 0x3A;
const END_MARKER = Buffer.from(';\n');

function frame(command, payload = Buffer.alloc(0)) {
    return Buffer.concat([Buffer.from(':'), Buffer.from(command), payload, Buffer.from(';\n')]);
}

function parseFrames(buffer) {
    let remainder = buffer;
    const frames = [];
    while (true) {
        const start = remainder.indexOf(START_MARKER);
        if (start < 0) { remainder = Buffer.alloc(0); break; }
        const end = remainder.indexOf(END_MARKER, start);
        if (end < 0) { remainder = remainder.subarray(start); break; }
        frames.push(remainder.subarray(start, end + END_MARKER.length));
        remainder = remainder.subarray(end + END_MARKER.length);
    }
    return { frames, remainder };
}

module.exports = { CMD, frame, parseFrames };
