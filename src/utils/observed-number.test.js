const { observedNumber, positiveMachineNumber } = require('./observed-number');
let pass = 0, fail = 0;
function ok(name, condition) {
    if (condition) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.error(`  ❌ ${name}`); }
}
console.log('observed-number.test.js');
for (const [input, expected] of [[0, 0], ['0', 0], [0.125, 0.125], ['12,5', 12.5], ['1 234,5', 1234.5],
    ['2,000.25', 2000.25], ['2.000,25', 2000.25], ['1.234', 1234], ['+12.5', 12.5], [' 42 ', 42]]) {
    ok(`observed value ${JSON.stringify(input)} preserves its numeric meaning`, observedNumber(input) === expected);
}
for (const space of [' ', '\u00a0', '\u202f', '\u2009', '\u2007']) {
    ok('confirmed space separators remain accepted', observedNumber(`1${space}234,5`) === 1234.5);
}
ok('fractional hourly observations retain /h support', observedNumber('12,5 /h', true) === 12.5);
for (const text of ['0.125 / h', '0,125/h', '+0.125 /h', '0.001/h', '0,000001 / h']) {
    const expected = Number(text.replace(/\s*\/\s*h\s*$/i, '').replace(',', '.'));
    ok(`sub-unit hourly output is decimal, never thousands: ${text}`, observedNumber(text, true) === expected);
}
ok('sub-unit balances use the same unambiguous decimal convention', observedNumber('0.125') === 0.125 && observedNumber('0,125') === 0.125);
ok('nonzero leading groups preserve established thousands parsing', observedNumber('1.234') === 1234 && observedNumber('1,234') === 1234);
ok('rate suffix cannot enter a balance', observedNumber('12,5 /h') === null);
for (const bad of [null, undefined, '', ' ', true, {}, [], NaN, Infinity, -1, '-1', 'garbage 100', '1.2.3', '1 23', '1e3', '1/2']) {
    ok(`unobserved or malformed values remain null: ${String(bad)}`, observedNumber(bad) === null);
}
for (const [input, expected] of [['0.125', 0.125], [0.125, 0.125], ['.25', 0.25], ['1e-3', 0.001], [' 2 ', 2]]) {
    ok(`machine price ${String(input)} preserves fractions`, positiveMachineNumber(input) === expected);
}
for (const bad of [null, undefined, '', '1,25', '1 000', 0, '0', -1, '-1', NaN, Infinity, 'Infinity', '1e999', '1.25 junk', true]) {
    ok(`invalid conversion rate remains null: ${String(bad)}`, positiveMachineNumber(bad) === null);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
