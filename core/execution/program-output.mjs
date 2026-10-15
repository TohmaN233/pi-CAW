import { openSync, writeSync, readSync, closeSync, fstatSync, fsyncSync, writeFileSync } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { noSymlinks, requireValue } from '../workflow-paths.mjs';

export const PROGRAM_REPLY_BYTES = 32768;
export const PROGRAM_DISK_BYTES = 64 * 1024 * 1024;
export const PROGRAM_ACTUAL_BYTES = 1024 * 1024;
export const programTextResult = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
export const serializedProgramResultBytes = value => Buffer.byteLength(JSON.stringify(programTextResult(value)));
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join('/');

// Capture never routes complete output through the provider transport. These
// files have exact broker ownership and closed immutable stream identities.
export function createProgramOutput(owner, { maxBytes = PROGRAM_DISK_BYTES } = {}) {
  const outputId = randomUUID(), streams = {}, opened = [];
  const manifestPath = join(owner.path, `${outputId}.manifest.json`);
  try {
    for (const stream of ['stdout', 'stderr']) {
      const path = join(owner.path, `${outputId}.${stream}`), fd = openSync(path, 'wx+', 0o600);
      opened.push(fd); streams[stream] = { path, fd, bytes: 0, hash: createHash('sha256'), sealed: null, sha256: null };
    }
  } catch (error) { for (const fd of opened) closeSync(fd); throw error; }
  let totalBytes = 0, finished = false, failure = null, sealingError = null, ownershipError = null;
  const reference = () => ({ output_id: outputId, broker_id: owner.summary.broker_id,
    manifest: `${outputId}.manifest.json`,
    streams: Object.fromEntries(Object.entries(streams).map(([name, item]) => [name, { total_bytes: item.bytes, sha256: item.sha256 }])),
    ...(failure ? { capture_error: failure.code } : {}) });
  const assertStream = async item => {
    try {
      await owner.assertOwned(); await noSymlinks(item.path);
      const stat = await lstat(item.path, { bigint: true });
      requireValue(finished && stat.isFile() && stat.nlink === 1n && stamp(stat) === item.sealed,
        'PI_PROGRAM_OUTPUT_OWNER', 'Program output identity or contents changed; evidence retained');
    } catch (error) { ownershipError = Object.assign(error, { retained_at: owner.path }); throw ownershipError; }
  };
  const readBytes = async (stream, start, count) => {
    const item = streams[stream]; await assertStream(item);
    const file = await open(item.path, 'r');
    try {
      requireValue(stamp(await file.stat({ bigint: true })) === item.sealed, 'PI_PROGRAM_OUTPUT_OWNER', 'Opened output file differs from its sealed identity');
      const bytes = Buffer.alloc(Math.min(count, item.bytes - start));
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, start + offset);
        requireValue(read.bytesRead > 0, 'PI_PROGRAM_OUTPUT_READ', 'Program output ended before its sealed byte count'); offset += read.bytesRead;
      }
      requireValue(stamp(await file.stat({ bigint: true })) === item.sealed, 'PI_PROGRAM_OUTPUT_OWNER', 'Opened output changed while reading');
      await assertStream(item); return bytes;
    } catch (error) {
      if (error.code === 'PI_PROGRAM_OUTPUT_OWNER') ownershipError = Object.assign(error, { retained_at: owner.path });
      throw error;
    } finally { await file.close(); }
  };
  return {
    outputId, reference,
    retentionError: () => sealingError ?? ownershipError,
    evidence: () => ({ ...reference(), manifest_path: manifestPath, spool_owner: owner.summary,
      stream_paths: Object.fromEntries(Object.entries(streams).map(([name, item]) => [name, item.path])) }),
    write(stream, chunk) {
      requireValue(!finished, 'PI_PROGRAM_OUTPUT_CLOSED', 'Program output capture is closed');
      if (failure) throw failure;
      try {
        requireValue(totalBytes + chunk.length <= maxBytes, 'PI_EXECUTION_OUTPUT', `Program output exceeds the explicit ${maxBytes}-byte disk capture limit; captured prefix remains available`);
        const item = streams[stream]; let offset = 0;
        while (offset < chunk.length) {
          const count = writeSync(item.fd, chunk, offset, chunk.length - offset);
          requireValue(count > 0, 'PI_PROGRAM_OUTPUT_WRITE', 'Program output write made no progress');
          item.hash.update(chunk.subarray(offset, offset + count)); item.bytes += count; totalBytes += count; offset += count;
        }
      } catch (error) { failure = error; throw error; }
    },
    finish(outcome = {}) {
      if (finished) { if (sealingError) throw sealingError; return; }
      const errors = [];
      for (const item of Object.values(streams)) {
        try {
          fsyncSync(item.fd);
          const stat = fstatSync(item.fd, { bigint: true }); item.sealed = stamp(stat); item.sha256 = item.hash.digest('hex');
          requireValue(stat.size === BigInt(item.bytes) && stat.nlink === 1n, 'PI_PROGRAM_OUTPUT_OWNER', 'Program output changed during capture');
          const observed = createHash('sha256'), buffer = Buffer.alloc(65536); let position = 0;
          while (position < item.bytes) {
            const count = readSync(item.fd, buffer, 0, Math.min(buffer.length, item.bytes - position), position);
            requireValue(count > 0, 'PI_PROGRAM_OUTPUT_READ', 'Program output sealing ended before its captured byte count');
            observed.update(buffer.subarray(0, count)); position += count;
          }
          requireValue(observed.digest('hex') === item.sha256 && stamp(fstatSync(item.fd, { bigint: true })) === item.sealed,
            'PI_PROGRAM_OUTPUT_OWNER', 'Program output bytes changed before sealing');
        }
        catch (error) { errors.push(error); }
        try { closeSync(item.fd); } catch (error) { errors.push(error); }
      }
      finished = true;
      try {
        writeFileSync(manifestPath, JSON.stringify({ schema_version: 1, ...reference(), workspace: owner.summary.workspace, seal_complete: errors.length === 0,
          ...(errors.length ? { sealing_errors: errors.map(error => error.code ?? 'PI_PROGRAM_OUTPUT_SEAL') } : {}),
          spool_owner_sha256: owner.summary.owner_sha256, outcome,
          streams: Object.fromEntries(Object.entries(streams).map(([name, item]) => [name, { file: `${outputId}.${name}`, total_bytes: item.bytes, sha256: item.sha256, identity: item.sealed }])) }), { flag: 'wx', mode: 0o600, flush: true });
      } catch (error) { errors.push(error); }
      if (errors.length) { sealingError = Object.assign(new AggregateError(errors, 'Program output sealing failed'), { code: errors[0].code ?? 'PI_PROGRAM_OUTPUT_SEAL', retained_at: owner.path }); throw sealingError; }
    },
    async actual(result) {
      requireValue(totalBytes <= PROGRAM_ACTUAL_BYTES, 'PI_EXECUTION_OUTPUT', 'Host structured program output exceeded its 1 MiB actual-operation contract');
      const stdout = (await readBytes('stdout', 0, streams.stdout.bytes)).toString('utf8');
      const stderr = (await readBytes('stderr', 0, streams.stderr.bytes)).toString('utf8');
      return { ...result, stdout, stderr, output: stdout + stderr };
    },
    async carrier(result) {
      if (totalBytes <= PROGRAM_REPLY_BYTES) {
        const stdoutBytes = await readBytes('stdout', 0, streams.stdout.bytes), stderrBytes = await readBytes('stderr', 0, streams.stderr.bytes);
        let stdout, stderr;
        try { stdout = new TextDecoder('utf8', { fatal: true }).decode(stdoutBytes); stderr = new TextDecoder('utf8', { fatal: true }).decode(stderrBytes); }
        catch { /* Invalid UTF-8 uses the explicitly declared base64 carrier below. */ }
        if (stdout !== undefined && stderr !== undefined) {
          const small = { ...result, stdout, stderr, output: stdout + stderr };
          if (serializedProgramResultBytes(small) <= PROGRAM_REPLY_BYTES) return small;
        }
      }
      const stdout = (await this.chunk('stdout', 0, 512)).text ?? '';
      const stderr = (await this.chunk('stderr', 0, 512)).text ?? '';
      const value = { ...result, stdout, stderr, output: stdout + stderr, output_complete: false, output_ref: reference(),
        continuation: 'Read each stream with read_program_output, starting at byte 0 and following next_byte; data_base64 preserves exact bytes.' };
      requireValue(serializedProgramResultBytes(value) <= PROGRAM_REPLY_BYTES, 'PI_PROGRAM_REPLY_SIZE', 'Program result metadata exceeded its serialized transport budget'); return value;
    },
    async chunk(stream, start, maxBytes) {
      requireValue(Object.hasOwn(streams, stream) && Number.isSafeInteger(start) && start >= 0 && start <= streams[stream].bytes
        && Number.isSafeInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 12000,
      'PI_PROGRAM_OUTPUT_ARGUMENTS', 'Read a declared stream at a valid byte offset with max_bytes from 1 through 12000');
      const item = streams[stream]; let bytes = await readBytes(stream, start, Math.min(maxBytes + 3, item.bytes - start));
      // Preserve complete Unicode characters for text consumers; base64 always
      // carries exact bytes, including arbitrary non-UTF8 process output.
      let end = Math.min(maxBytes, bytes.length);
      while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      if (!end && bytes.length) end = Math.min(maxBytes, bytes.length);
      const make = count => {
        const data = bytes.subarray(0, count); let text;
        try { text = new TextDecoder('utf8', { fatal: true }).decode(data); } catch { /* The exact bytes are explicitly represented by base64. */ }
        return { output_id: outputId, stream, start_byte: start, next_byte: start + count, total_bytes: item.bytes,
          sha256: item.sha256, complete: start + count === item.bytes, data_base64: data.toString('base64'), ...(text !== undefined ? { text } : { encoding: 'base64' }) };
      };
      let value = make(end);
      while (serializedProgramResultBytes(value) > PROGRAM_REPLY_BYTES) {
        end = Math.floor(end / 2);
        while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
        requireValue(end > 0, 'PI_PROGRAM_REPLY_SIZE', 'Program continuation metadata exceeded its transport budget'); value = make(end);
      }
      return value;
    },
  };
}
