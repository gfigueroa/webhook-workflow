import { useMemo, useState } from "react";
import { HowItWorks } from "./HowItWorks";
import { useWebhook } from "./hooks/useWebhook";
import { DEFAULT_PAYLOAD, type WebhookEvent } from "./types";
import {
  computeSignature,
  generateEventId,
  generateOrderId,
  generatePaymentId,
} from "./utils/crypto";

type Page = "main" | "howItWorks";

function App() {
  const [currentPage, setCurrentPage] = useState<Page>("main");
  const isLocalhost = window.location.hostname === "localhost";
  const defaultSecret = isLocalhost ? "test-secret" : "demo-webhook-secret";

  const [webhookUrl, setWebhookUrl] = useState(
    `${window.location.origin}/webhook`,
  );
  const [secret, setSecret] = useState(defaultSecret);
  const [payloadText, setPayloadText] = useState(
    JSON.stringify(DEFAULT_PAYLOAD, null, 2),
  );
  const [curlCommand, setCurlCommand] = useState("");
  const [copySuccess, setCopySuccess] = useState(false);

  const {
    sendWebhook,
    response,
    taskStatus,
    isLoading,
    isPolling,
    error,
    logs,
    clearLogs,
  } = useWebhook({ webhookUrl, secret });

  const payload = useMemo(() => {
    try {
      return JSON.parse(payloadText) as WebhookEvent;
    } catch {
      return null;
    }
  }, [payloadText]);

  const handleSend = async () => {
    if (!payload) return;
    await sendWebhook(payload);
  };

  const handleFormat = () => {
    if (payload) {
      setPayloadText(JSON.stringify(payload, null, 2));
    }
  };

  const handleRandomize = () => {
    if (payload) {
      const newPayload = {
        ...payload,
        event_id: generateEventId(),
        timestamp: new Date().toISOString(),
        data: {
          ...payload.data,
          payment_id: generatePaymentId(),
          order_id: generateOrderId(),
        },
      };
      setPayloadText(JSON.stringify(newPayload, null, 2));
    }
  };

  const handleGenerateCurl = async () => {
    if (!payload || !secret) return;

    const payloadStr = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await computeSignature(payloadStr, timestamp, secret);

    const cmd = `curl -X POST '${webhookUrl}' \\
  -H 'Content-Type: application/json' \\
  -H 'X-Webhook-Signature: sha256=${signature}' \\
  -H 'X-Webhook-Timestamp: ${timestamp}' \\
  -d '${payloadStr}'`;

    setCurlCommand(cmd);
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(curlCommand);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  };

  if (currentPage === "howItWorks") {
    return <HowItWorks onBack={() => setCurrentPage("main")} />;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-7xl px-4 py-8">
        {/* Header */}
        <header className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-normal tracking-tight mb-2">
              WEBHOOK DEMO
            </h1>
            <p className="text-zinc-500 text-sm">
              Test HMAC signature validation and trigger async tasks with{" "}
              <a
                href="https://render.com/docs/workflows"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white underline hover:no-underline"
              >
                Render Workflows
              </a>
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCurrentPage("howItWorks")}
            className="border border-zinc-600 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500 hover:text-white"
          >
            How It Works
          </button>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Left Column - Configuration & Payload */}
          <div className="space-y-6">
            {/* Configuration */}
            <section className="border border-zinc-800 bg-zinc-900 p-4">
              <h2 className="mb-4 text-lg font-semibold">Configuration</h2>

              <div className="space-y-4">
                <div>
                  <label
                    htmlFor="webhook-url"
                    className="mb-1 block text-sm text-zinc-400"
                  >
                    Webhook URL
                  </label>
                  <input
                    id="webhook-url"
                    type="text"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    className="w-full border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm focus:border-zinc-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label
                    htmlFor="webhook-secret"
                    className="mb-1 block text-sm text-zinc-400"
                  >
                    Webhook Secret
                  </label>
                  <input
                    id="webhook-secret"
                    type="text"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    className="w-full border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm focus:border-zinc-500 focus:outline-none"
                  />
                  {!isLocalhost && (
                    <p className="mt-1 text-xs text-zinc-500">
                      Default secret for demo. Change in Render Dashboard for
                      production.
                    </p>
                  )}
                </div>
              </div>
            </section>

            {/* Payload Editor */}
            <section className="border border-zinc-800 bg-zinc-900 p-4">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Payload</h2>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleFormat}
                    className="border border-zinc-600 px-3 py-1 text-sm text-zinc-300 hover:border-zinc-500 hover:text-white"
                  >
                    Format
                  </button>
                  <button
                    type="button"
                    onClick={handleRandomize}
                    className="border border-zinc-600 px-3 py-1 text-sm text-zinc-300 hover:border-zinc-500 hover:text-white"
                  >
                    Randomize IDs
                  </button>
                </div>
              </div>

              <textarea
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
                className="h-80 w-full border border-zinc-700 bg-zinc-800 p-3 font-mono text-sm focus:border-zinc-500 focus:outline-none"
                spellCheck={false}
              />

              {!payload && (
                <p className="mt-2 text-sm text-red-400">Invalid JSON</p>
              )}

              <button
                type="button"
                onClick={handleSend}
                disabled={isLoading || !payload || !secret}
                className="mt-4 w-full bg-white px-4 py-2 font-medium text-black hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isLoading ? "Sending..." : "Send Webhook"}
              </button>
            </section>

            {/* cURL Generator */}
            <section className="border border-zinc-800 bg-zinc-900 p-4">
              <h2 className="mb-2 text-lg font-semibold">cURL Command</h2>
              <p className="mb-4 text-sm text-zinc-400">
                Generate a cURL command to test from your terminal and see
                real-time updates in this UI.
              </p>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleGenerateCurl}
                  disabled={!payload || !secret}
                  className="bg-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Generate
                </button>
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={!curlCommand}
                  className="border border-zinc-600 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {copySuccess ? "Copied!" : "Copy"}
                </button>
              </div>

              {curlCommand && (
                <pre className="mt-4 overflow-x-auto border border-zinc-700 bg-zinc-800 p-3 text-xs">
                  {curlCommand}
                </pre>
              )}
            </section>
          </div>

          {/* Right Column - Response & Status */}
          <div className="space-y-6">
            {/* Response */}
            <section className="border border-zinc-800 bg-zinc-900 p-4">
              <h2 className="mb-4 text-lg font-semibold">Response</h2>

              {error && (
                <div className="border border-red-900 bg-red-950 p-3 text-red-400">
                  {error}
                </div>
              )}

              {response && (
                <pre className="overflow-x-auto border border-zinc-700 bg-zinc-800 p-3 text-sm">
                  {JSON.stringify(response, null, 2)}
                </pre>
              )}

              {!response && !error && (
                <p className="text-zinc-500">No response yet</p>
              )}
            </section>

            {/* Task Status */}
            <section className="border border-zinc-800 bg-zinc-900 p-4">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Task Status</h2>
                {isPolling && (
                  <span className="flex items-center gap-2 text-sm text-zinc-400">
                    <span className="h-2 w-2 animate-pulse bg-green-500" />
                    Polling...
                  </span>
                )}
              </div>

              {taskStatus ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block px-2 py-1 text-xs font-medium ${
                        taskStatus.status === "completed"
                          ? "bg-green-900 text-green-300"
                          : taskStatus.status === "failed"
                            ? "bg-red-900 text-red-300"
                            : "bg-yellow-900 text-yellow-300"
                      }`}
                    >
                      {taskStatus.status}
                    </span>
                    <span className="font-mono text-sm text-zinc-400">
                      {taskStatus.task_run_id}
                    </span>
                  </div>

                  {taskStatus.subtasks.length > 0 && (
                    <div>
                      <h3 className="mb-2 text-sm font-medium text-zinc-300">
                        Subtasks ({taskStatus.subtasks.length})
                      </h3>
                      <div className="space-y-1">
                        {taskStatus.subtasks.map((subtask) => (
                          <div
                            key={subtask.task_run_id}
                            className="flex items-center gap-2 text-sm"
                          >
                            <span
                              className={`inline-block h-2 w-2 ${
                                subtask.status === "completed"
                                  ? "bg-green-500"
                                  : subtask.status === "failed"
                                    ? "bg-red-500"
                                    : "bg-yellow-500"
                              }`}
                            />
                            <span className="font-mono text-zinc-400">
                              {subtask.task_id}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {taskStatus.results && (
                    <details className="group">
                      <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-300">
                        View Results
                      </summary>
                      <pre className="mt-2 max-h-64 overflow-auto border border-zinc-700 bg-zinc-800 p-3 text-xs">
                        {JSON.stringify(taskStatus.results, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ) : (
                <p className="text-zinc-500">No task running</p>
              )}
            </section>

            {/* Logs */}
            <section className="border border-zinc-800 bg-zinc-900 p-4">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Logs</h2>
                <button
                  type="button"
                  onClick={clearLogs}
                  className="border border-zinc-600 px-3 py-1 text-sm text-zinc-300 hover:border-zinc-500 hover:text-white"
                >
                  Clear
                </button>
              </div>

              <div className="h-48 overflow-y-auto border border-zinc-700 bg-zinc-800 p-3 font-mono text-xs">
                {logs.length > 0 ? (
                  logs.map((log) => (
                    <div key={log} className="text-zinc-400">
                      {log}
                    </div>
                  ))
                ) : (
                  <span className="text-zinc-500">No logs yet</span>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
