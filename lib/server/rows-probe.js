/**
 * Build the stored result for a tool call.
 *
 * Session logs below version 4 keep a result as a user message holding a single `tool-result`
 * block. From version 4 on, the result is a message of its own with `role: "tool"`, the call id
 * carried on the message, and the output as ordinary text blocks; the older wrapper block is
 * rejected outright there.
 */
export function toolResultMessage(version, callId, id, text, isError = false) {
    const blocks = [{ type: "text", text }];
    if (version >= 4) {
        return {
            id,
            role: "tool",
            toolCallId: callId,
            source: { kind: "tool", callId },
            content: blocks,
            isError,
        };
    }
    return {
        id,
        role: "user",
        source: { kind: "tool", callId },
        content: [{ type: "tool-result", toolCallId: callId, content: blocks, isError }],
    };
}
//# sourceMappingURL=rows-probe.js.map