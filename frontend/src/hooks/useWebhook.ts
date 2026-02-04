import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskStatus, WebhookEvent, WebhookResponse } from "../types";
import { computeSignature } from "../utils/crypto";

interface UseWebhookOptions {
  webhookUrl: string;
  secret: string;
}

interface UseWebhookReturn {
  sendWebhook: (payload: WebhookEvent) => Promise<void>;
  response: WebhookResponse | null;
  taskStatus: TaskStatus | null;
  isLoading: boolean;
  isPolling: boolean;
  error: string | null;
  logs: string[];
  clearLogs: () => void;
}

export function useWebhook({
  webhookUrl,
  secret,
}: UseWebhookOptions): UseWebhookReturn {
  const [response, setResponse] = useState<WebhookResponse | null>(null);
  const [taskStatus, setTaskStatus] = useState<TaskStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const pollingRef = useRef<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${timestamp}] ${message}`]);
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // Set up SSE connection
  useEffect(() => {
    const baseUrl = window.location.origin;
    const eventSource = new EventSource(`${baseUrl}/events`);
    eventSourceRef.current = eventSource;

    eventSource.addEventListener("webhook", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "webhook_received") {
          addLog(`SSE: Webhook received - ${data.data.response.status}`);
          setResponse(data.data.response);
          if (data.data.response.task_run_id) {
            startPolling(data.data.response.task_run_id);
          }
        }
      } catch (e) {
        console.error("Failed to parse SSE event:", e);
      }
    });

    eventSource.addEventListener("ping", () => {
      // Keep-alive ping, ignore
    });

    eventSource.onerror = () => {
      addLog("SSE: Connection error, reconnecting...");
    };

    return () => {
      eventSource.close();
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [addLog]);

  const startPolling = useCallback(
    (taskRunId: string) => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }

      setIsPolling(true);
      addLog(`Polling task status: ${taskRunId}`);

      const poll = async () => {
        try {
          const baseUrl = window.location.origin;
          const res = await fetch(`${baseUrl}/task-status/${taskRunId}`);
          if (res.ok) {
            const status: TaskStatus = await res.json();
            setTaskStatus(status);

            if (status.status === "completed" || status.status === "failed") {
              addLog(`Task ${status.status}: ${taskRunId}`);
              setIsPolling(false);
              if (pollingRef.current) {
                clearInterval(pollingRef.current);
                pollingRef.current = null;
              }
            }
          }
        } catch (e) {
          console.error("Polling error:", e);
        }
      };

      // Initial poll
      poll();

      // Poll every 2 seconds
      pollingRef.current = window.setInterval(poll, 2000);
    },
    [addLog],
  );

  const sendWebhook = useCallback(
    async (payload: WebhookEvent) => {
      if (!secret) {
        setError("Webhook secret is required");
        return;
      }

      setIsLoading(true);
      setError(null);
      setResponse(null);
      setTaskStatus(null);

      try {
        const payloadStr = JSON.stringify(payload);
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = await computeSignature(payloadStr, timestamp, secret);

        addLog(`Sending webhook to ${webhookUrl}`);

        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": `sha256=${signature}`,
            "X-Webhook-Timestamp": timestamp,
          },
          body: payloadStr,
        });

        const data = await res.json();

        if (!res.ok) {
          setError(data.detail || "Request failed");
          addLog(`Error: ${data.detail || res.statusText}`);
        } else {
          setResponse(data);
          addLog(`Response: ${data.status} - ${data.message}`);

          if (data.task_run_id) {
            startPolling(data.task_run_id);
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unknown error";
        setError(message);
        addLog(`Error: ${message}`);
      } finally {
        setIsLoading(false);
      }
    },
    [webhookUrl, secret, addLog, startPolling],
  );

  return {
    sendWebhook,
    response,
    taskStatus,
    isLoading,
    isPolling,
    error,
    logs,
    clearLogs,
  };
}
