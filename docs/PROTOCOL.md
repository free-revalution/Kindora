# Protocol — KSA 0.1

KSA = **Kindora Social Agent Protocol**, version `0.1`.

## Envelope

```json
{
  "protocol": "KSA",
  "version": "0.1",
  "messageId": "uuid",
  "timestamp": "ISO-8601",
  "type": "profile_exchange",
  "sender": "agent_id",
  "payload": {}
}
```

## Message Types (V0.1)

- `hello`
- `profile_exchange`
- `match_request`
- `match_response`
- `icebreaker_request`
- `icebreaker_response`
- `chat_message`
- `permission_request`
- `disconnect`

## Validation Rules

1. `protocol` MUST be `"KSA"`.
2. `version` MUST be a supported version (`0.1` only in V0.1).
3. `messageId` MUST be unique; replays of the same id are rejected.
4. `timestamp` MUST be within an acceptable skew window (default 60s).
5. `type` MUST be one of the V0.1 types listed above.
6. `payload` MUST validate against the type's schema.

## Replay Protection

- Maintain a short-lived LRU of recent `messageId`s.
- Reject messages older than the skew window.

## Privacy Boundary

Exchanged payloads MUST NOT contain:

- API keys
- Private keys
- Local file paths
- Full conversation history
- Contacts
- Exact location
- System information
