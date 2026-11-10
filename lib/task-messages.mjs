import { randomUUID } from 'node:crypto';
import { requireValue } from '../core/workflow-paths.mjs';
import { digest } from '../core/workflow-revisions.mjs';

export function validateNodeMessage(message) {
  requireValue(typeof message === 'string' && message.trim().length > 0 && Buffer.byteLength(message) <= 12000,
    'PI_NODE_MESSAGE_INPUT', 'message must be nonempty text of at most 12000 UTF-8 bytes');
}

// One delivery owner per actual SDK turn. Messages never start another turn,
// change the task grant, or count as a Workflow semantic repair attempt.
export function taskMessageDelivery({ session, available, authorize, observe }) {
  const pending = new Map();
  let accepting = true;
  const assertAvailable = () => {
    requireValue(accepting, 'PI_NODE_NOT_RUNNING', 'The exact worker turn has already settled');
    available();
  };
  return {
    assertSubmissionReady() {
      requireValue(!pending.size, 'PI_NODE_MESSAGE_PENDING',
        'A parent instruction is queued. Read it before submitting the declared semantic result; keep the original result schema and access grant.');
    },
    observe(event) {
      if (event.type !== 'message_start' || event.message.role !== 'user') return;
      const content = event.message.content;
      const text = typeof content === 'string' ? content : content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      const id = /^PI_CAW_NODE_MESSAGE ([a-f0-9-]{36})\n/.exec(text)?.[1];
      const delivery = pending.get(id);
      if (!delivery) return;
      delivery.status = 'consumed'; pending.delete(id);
      observe({ ...delivery.metadata, phase: 'consumed' });
    },
    async send({ message, sender_session_id }) {
      validateNodeMessage(message); assertAvailable();
      await authorize?.(); assertAvailable();
      const message_id = randomUUID(), sha256 = digest(message), bytes = Buffer.byteLength(message);
      const metadata = { tool: 'node_message', message_id, sender_session_id, sha256, bytes };
      await observe({ ...metadata, phase: 'requested', message });
      assertAvailable();
      const delivery = { status: 'queued', metadata };
      pending.set(message_id, delivery);
      // The public native Agent queue is synchronous. AgentSession.steer runs
      // asynchronous input/template hooks first, allowing a completed turn to
      // acquire a late queue item. This task already owns its literal input.
      try {
        session.agent.steer({ role: 'user', timestamp: Date.now(), content: [{ type: 'text',
          text: `PI_CAW_NODE_MESSAGE ${message_id}\nSupplemental instruction from the parent agent. Continue this task in the same session. Keep the declared result schema, access grant and tool restrictions.\n\n${message}` }] });
      } catch (error) { pending.delete(message_id); throw error; }
      await observe({ ...metadata, phase: 'queued' });
      return { message_id, status: delivery.status, sha256, bytes };
    },
    async settle() {
      accepting = false;
      requireValue(!pending.size, 'PI_NODE_MESSAGE_UNCONSUMED',
        'The worker settled before consuming an accepted parent instruction; no successful completion can be recorded');
    },
    close(code = 'PI_NODE_MESSAGE_UNCONSUMED') {
      accepting = false;
      if (!pending.size) return;
      session.agent.clearSteeringQueue();
      for (const delivery of pending.values()) observe({ ...delivery.metadata, phase: 'rejected', code });
      pending.clear();
    },
  };
}
