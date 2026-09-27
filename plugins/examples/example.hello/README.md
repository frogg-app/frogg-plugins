# Hello

Smallest useful daemon plugin. Adds a **Hello: greet** Command Center entry. Invoking it calls the
plugin RPC `example.hello.greet`, which counts the agents on the host and shows a notification.

Capabilities: `rpc` (handle the command), `ui.contribute` (notify), `agent.read` (list agents).
