/**
 * vibernt/shard: split a job's test files across matrix legs (docs/ACTIONS.md).
 *
 * `mode: fixed` (default): this leg's test files, split by recorded duration with one plan per workflow run; every leg
 * and every re-run reads that plan, so each file runs in exactly one leg. When the API cannot be reached the leg
 * outputs every file (it runs the whole suite) instead of guessing, so no file is ever left out.
 *
 * `mode: plan` (fan-out, docs/TEST_INTELLIGENCE.md#fan-out): a plan job lists the test files and records the run's
 * fan-out plan; it outputs `matrix` (a JSON list of leg numbers) for the legs' `strategy.matrix`, because GitHub fixes a
 * matrix's size when the plan job finishes.
 *
 * `mode: pull`: a matrix leg pulls its work from the run's queue: it claims a unit, runs `run` with the unit's files
 * (`{files}` in the command, and VIBERNT_FILES), uploads the unit's JUnit report, heartbeats its lease, and repeats
 * until the queue is drained, so a slow or lost leg's work is taken over by the others. It fails when a unit it ran
 * failed (and won: a speculative copy that lost does not count).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { input, booleanInput, setOutput, summary, info, warning, call, jobKey, listFiles, spaceList, main } from '../lib/vibernt.mjs';
import { junitCases } from '../lib/junit.mjs';

// Benchmark copy (vidhatanand forks, 2026-10-08), changed from cri-ci actions/shard at a403b02d:
//  - `files-from`: the test files as a newline-separated list in a checked-in file (exact paths are valid globs), because
//    a 4,000-path `pattern` input exceeds the 128 KiB limit of one environment variable;
//  - `batch` (pull mode): claims up to that many units at once (the queue's batched claim, as the native runner does) and
//    runs them in ONE invocation of `run`, then attributes each JUnit case to the unit whose file names it and posts each
//    unit's result with its cases (`batch: 1` is the published behaviour: one unit per claim, the XML posted as is);
//  - queue calls are retried on a network error or a 5xx (4 attempts, as the native runner's QueueClient);
//  - `unit-timeout-floor-ms` (pull mode): the least time a batch may run before it is stopped as a timeout.

const DEFAULT_PATTERN = ['**/*.test.{js,mjs,cjs,ts,mts,tsx,jsx}', '**/*.spec.{js,mjs,cjs,ts,mts,tsx,jsx}', '**/test_*.py', '**/*_test.py', '**/*_test.go'].join('\n');
const MODES = ['fixed', 'plan', 'pull'];

/** `{a,b}` alternatives expanded, since the glob helper matches `*`, `**` and `?` only. */
function expand(patterns) {
    return patterns.split(/\n/).map(x => x.trim()).filter(Boolean).flatMap(p => {
        const m = /\{([^{}]+)\}/.exec(p);
        return m ? expand(m[1].split(',').map(alt => p.replace(m[0], alt)).join('\n')) : [p];
    });
}

function emit(files, extra = {}) {
    setOutput('files', spaceList(files));
    setOutput('files-json', JSON.stringify(files));
    setOutput('count', String(files.length));
    for (const [k, v] of Object.entries(extra))
        setOutput(k, String(v));
}

const project = () => (input('project') ? { project: input('project') } : {});
/** The job's test files: `files-from` (one path per line) when given, else the `pattern` globs. */
function testFiles() {
    const from = input('files-from');
    if (from) {
        const wanted = new Set(readFileSync(from, 'utf8').split(/\n/).map(x => x.trim()).filter(Boolean));
        const root = process.env.GITHUB_WORKSPACE || process.cwd();
        const present = [...wanted].filter(f => !f.startsWith('/') && !f.split('/').includes('..') && existsSync(join(root, f))).sort();
        const missing = [...wanted].filter(f => !present.includes(f));
        if (missing.length)
            warning(`${missing.length} listed test file(s) are not in the checkout, for example ${missing[0]}.`);
        return present;
    }
    return listFiles(expand(input('pattern', DEFAULT_PATTERN)).join('\n'));
}

async function fixed(job) {
    const index = Number(input('index', '')), total = Number(input('total', ''));
    if (!Number.isInteger(total) || total < 2 || total > 16 || !Number.isInteger(index) || index < 1 || index > total)
        throw new Error('index must be 1 to total, and total 2 to 16 (for example index: ${{ matrix.shard }}, total: 4).');
    const files = listFiles(expand(input('pattern', DEFAULT_PATTERN)).join('\n'));
    if (!files.length)
        throw new Error('No test file matches the pattern.');
    let result;
    try {
        result = await call('/v1/actions/shard', { job, index, total, files, ...project() });
    }
    catch (problem) {
        if (booleanInput('fail-on-error', false))
            throw problem;
        warning(`Shard plan unavailable (${problem.message}); this leg runs every test file.`);
        return emit(files, { basis: 'unavailable' });
    }
    emit(result.files, { basis: result.basis, digest: result.digest });
    info(`Shard ${index} of ${total}: ${result.files.length} file(s), split ${result.basis}${result.balance ? `, balance ${result.balance}` : ''}.`);
    summary(`### Vibernt CI shard ${index} of ${total}\n\n${result.files.length} test files (${result.basis}). Plan ${result.digest}.`);
}

async function plan(job) {
    const files = testFiles();
    if (!files.length)
        throw new Error('No test file matches the pattern.');
    const max = input('max') ? Number(input('max')) : undefined;
    if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 50))
        throw new Error('max must be 1 to 50.');
    let result;
    try {
        result = await call('/v1/actions/shard', { job, mode: 'plan', files, ...(max ? { max } : {}), ...(input('target') ? { target: input('target') } : {}), ...(input('fail-fast') ? { failFast: input('fail-fast') } : {}), ...project() });
    }
    catch (problem) {
        if (booleanInput('fail-on-error', false))
            throw problem;
        // One leg: it pulls nothing and runs every file (see pull below), so nothing is left out.
        warning(`Fan-out plan unavailable (${problem.message}); one leg runs every test file.`);
        setOutput('matrix', '[1]');
        setOutput('shards', '1');
        setOutput('basis', 'unavailable');
        return;
    }
    setOutput('matrix', JSON.stringify(result.matrix));
    setOutput('shards', String(result.shards));
    setOutput('basis', result.basis);
    setOutput('digest', result.digest);
    info(`Fan-out plan: ${result.shards} shard(s), ${files.length} test file(s), expected wall ${Math.round((result.expected?.wallMs || 0) / 1000)} s.`);
    summary(`### Vibernt CI fan-out plan\n\n${result.shards} shards for ${files.length} test files (${result.basis}). Plan ${result.digest}.`);
}

/** Runs the leg's command for one unit: `{ code, timedOut, stopped }`. */
function runUnit(command, files, stop, timeoutMs) {
    const list = files.join(' ');
    return new Promise(resolve => {
        const child = spawn('bash', ['-eo', 'pipefail', '-c', command.replaceAll('{files}', list)], { stdio: 'inherit', env: { ...process.env, VIBERNT_FILES: list }, detached: true });
        let timedOut = false;
        const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { } };
        const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1000, timeoutMs));
        const watch = setInterval(() => { if (stop()) kill(); }, 250);
        child.on('close', code => { clearTimeout(timer); clearInterval(watch); resolve({ code, timedOut, stopped: !timedOut && stop() }); });
    });
}

async function queuePost(grant, op, body) {
    // Benchmark copy: a network error or a 5xx is retried (as the native runner's QueueClient does, 4 attempts).
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt)
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        let response;
        try {
            response = await fetch(`${grant.queueUrl}/${op}`, { method: 'POST', headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        }
        catch (problem) {
            last = problem;
            continue;
        }
        const data = await response.json().catch(() => ({}));
        if (response.ok)
            return data;
        last = Object.assign(new Error(`${data?.error?.code || 'HTTP_' + response.status}: ${data?.error?.message || ''}`), { status: response.status });
        if (response.status < 500)
            throw last;
    }
    throw last;
}

const norm = path => String(path || '').replace(/\\/g, '/').replace(/^\.\//, '');
/**
 * Each case of a batch's reports to the unit whose files name it (its file, else its suite or classname when that is
 * a path of the batch, also as a suffix: a package-relative path), with `file` set to the unit's repository path; a
 * case no file names goes to the batch's first unit, so every test is reported once (runner/fanout.py `attribute`).
 */
function attribute(cases, batch) {
    const owner = new Map();
    for (const unit of batch)
        for (const f of unit.files)
            owner.set(norm(f), unit.id);
    const out = new Map(batch.map(u => [u.id, []]));
    for (const c of cases) {
        let id = null, file = null;
        for (const candidate of [c.file, c.suite]) {
            const name = norm(candidate);
            if (!name)
                continue;
            if (owner.has(name)) {
                id = owner.get(name);
                file = name;
                break;
            }
            const match = [...owner.keys()].find(f => f.endsWith('/' + name) || name.endsWith('/' + f));
            if (match) {
                id = owner.get(match);
                file = match;
                break;
            }
        }
        out.get(id ?? batch[0].id).push({ ...c, file: file || c.file });
    }
    return out;
}

async function pull(job) {
    const index = Number(input('index', ''));
    const command = input('run');
    const report = input('junit', 'junit.xml');
    if (!Number.isInteger(index) || index < 1 || index > 50)
        throw new Error('index must be 1 to 50 (for example index: ${{ matrix.shard }}).');
    if (!command)
        throw new Error('Pull mode needs `run`: the test command, with {files} where the unit\'s test files go (they are also in VIBERNT_FILES).');
    let grant;
    try {
        grant = await call('/v1/actions/shard', { job, mode: 'pull', index, ...project() });
    }
    catch (problem) {
        if (booleanInput('fail-on-error', false) || index > 1)
            throw problem;
        // The plan was unavailable too: leg 1 runs the whole suite, so no test is left out.
        warning(`Fan-out queue unavailable (${problem.message}); this leg runs every test file.`);
        const files = testFiles();
        const { code } = await runUnit(command, files, () => false, 6 * 3600000);
        if (code !== 0)
            throw new Error(`The test command failed (exit ${code}).`);
        return;
    }
    const leases = new Set();
    let cancelled = new Set(), stopped = false;
    const beat = setInterval(() => {
        queuePost(grant, 'heartbeat', { leases: [...leases] }).then(answer => {
            for (const lease of answer.cancel || [])
                cancelled.add(lease);
            if (answer.stop)
                stopped = true;
        }).catch(() => { });
    }, Math.max(1000, grant.heartbeatMs || 10000));
    const batchMax = Math.max(1, Math.min(64, Number(input('batch', '1')) || 1));
    let failed = 0, units = 0, won = 0, batches = 0;
    try {
        for (;;) {
            const answer = await queuePost(grant, 'claim', batchMax > 1 ? { batch: batchMax } : {});
            if (answer.stop || answer.done)
                break;
            if (answer.wait) {
                await new Promise(resolve => setTimeout(resolve, Math.min(5000, answer.wait)));
                continue;
            }
            const batch = answer.units || [answer.unit];
            units += batch.length;
            batches++;
            for (const u of batch)
                leases.add(u.lease);
            for (const path of listFiles(report))
                rmSync(path, { force: true });
            const files = batch.flatMap(u => u.files);
            info(`Batch ${batches}: ${batch.length} unit(s) [${batch.map(u => u.id).join(',')}]${batch.some(u => u.speculative) ? ' (speculative copy)' : ''}, ${files.length} file(s), estimated ${Math.round(batch.reduce((n, u) => n + (u.estMs || 0), 0) / 1000)} s.`);
            const started = Date.now();
            // Benchmark copy: `unit-timeout-floor-ms` raises the queue's unit timeout (2 minutes for a file with no recorded
            // duration, which killed every adapter integration file on the first run and so never recorded one).
            const budget = Math.max(Math.max(...batch.map(u => u.timeoutMs || 1800000)), 3 * batch.reduce((n, u) => n + (u.estMs || 0), 0), Number(input('unit-timeout-floor-ms', '0')) || 0);
            const ran = await runUnit(command, files, () => stopped || batch.every(u => cancelled.has(u.lease)), budget);
            const wall = Date.now() - started;
            for (const u of batch)
                leases.delete(u.lease);
            const code = ran.code;
            let cases = [], unreadable = false, found = 0;
            if (!ran.stopped && !ran.timedOut)
                for (const path of listFiles(report).slice(0, 20)) {
                    found++;
                    try {
                        cases.push(...junitCases(readFileSync(path, 'utf8')).cases);
                    }
                    catch (problem) {
                        unreadable = true;
                        warning(`Report ${path} could not be read (${problem.message}).`);
                    }
                }
            const byUnit = attribute(cases, batch);
            // A failed run that names no failing test (a crash, a missing or broken report) fails every unit of the batch.
            const unexplained = !ran.stopped && !ran.timedOut && (code !== 0 || unreadable || !found) && !cases.some(c => c.status === 'failed');
            info(`Batch ${batches} done in ${Math.round(wall / 1000)} s: exit ${code}, ${cases.length} case(s), ${cases.filter(c => c.status === 'failed').length} failed${unexplained ? ' (failure without a failing test: every unit fails)' : ''}.`);
            for (const u of batch) {
                const mine = byUnit.get(u.id) || [];
                const status = ran.stopped || cancelled.has(u.lease) ? 'cancelled' : ran.timedOut ? 'timeout' : unexplained || mine.some(c => c.status === 'failed') ? 'failed' : 'passed';
                const measured = mine.reduce((n, c) => n + (c.durationMs || 0), 0);
                const result = await queuePost(grant, 'result', {
                    lease: u.lease, status, durationMs: measured > 0 ? measured : Math.round(wall / batch.length), exitCode: Number.isInteger(code) ? code : null,
                    cases: status === 'cancelled' ? [] : mine.slice(0, 5000).map(c => ({ suite: c.suite, name: c.name, file: c.file, status: c.status, durationMs: c.durationMs, message: c.message }))
                });
                if (result.winner && status !== 'cancelled') {
                    won++;
                    if (status !== 'passed') {
                        failed++;
                        info(`Unit ${u.id} failed: ${mine.filter(c => c.status === 'failed').slice(0, 5).map(c => `${c.file} > ${c.name}`).join('; ') || 'no failing test named'}.`);
                    }
                }
            }
        }
    }
    finally {
        clearInterval(beat);
    }
    setOutput('units', String(units));
    summary(`### Vibernt CI fan-out leg ${index}\n\n${units} unit(s) in ${batches} batch(es) run, ${won} result(s) kept, ${failed} failed.${stopped ? ' The group was stopped (fail-fast).' : ''}`);
    if (failed || stopped)
        throw new Error(stopped ? 'A test failed on another leg and fail-fast stopped this group.' : `${failed} test unit(s) failed.`);
}

main(async () => {
    const job = jobKey();
    const mode = input('mode', 'fixed');
    if (!MODES.includes(mode))
        throw new Error('mode must be fixed, plan or pull.');
    if (mode === 'plan')
        return plan(job);
    if (mode === 'pull')
        return pull(job);
    return fixed(job);
});
