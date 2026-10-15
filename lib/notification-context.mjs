const brief = value => typeof value === 'string' ? value.slice(0, 600) : undefined;

/** Project persisted UI results at the model boundary, including historical cards. */
export function workflowNotification(event) {
  const files = [...new Set((event.feedback?.files ?? []).filter(value => typeof value === 'string'))];
  const error = event.error ?? event.feedback?.error;
  const summary = brief(event.summary ?? event.result?.summary);
  return {
    run_id: event.run_id,
    status: event.status,
    ...(event.feedback?.workflow_name ? { workflow_name: event.feedback.workflow_name } : {}),
    ...(summary ? { summary } : {}),
    ...(files.length ? { files: files.slice(0, 12), ...(files.length > 12 ? { additional_files: files.length - 12 } : {}) } : {}),
    ...(error ? { error: { code: error.code, message: brief(error.message) } } : {}),
    details: 'Full result and execution records remain in the UI; read artifacts or use caw get/inspect_run only when needed.',
  };
}

export function projectWorkflowContext(messages) {
  const seen = new Set();
  return messages.flatMap(message => {
    if (message.role !== 'custom') return [message];
    if (message.customType === 'pi-caw:status') return [];
    if (message.customType !== 'pi-caw:completion') return [message];
    const text = typeof message.content === 'string' ? message.content
      : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const event = JSON.parse(text);
    // Independent Role replies are actual delegation results, not Workflow cards.
    if (!event.run_id) return [message];
    const content = JSON.stringify(workflowNotification(event));
    const identity = event.delivery_id ?? content;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ role: 'custom', customType: 'pi-caw:notification', content, display: false, timestamp: message.timestamp }];
  });
}
