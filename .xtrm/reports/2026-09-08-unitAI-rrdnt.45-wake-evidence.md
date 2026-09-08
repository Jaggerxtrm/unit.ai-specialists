# unitAI-rrdnt.45 — coordinator wake-up: live evidence

pi 0.85.1 · model nano-gpt/deepseek/deepseek-v4-flash-0731:thinking · specialist live-wake-asker (READ_ONLY) · bead unitAI-jxcbf (throwaway probe)

## 1. Wake primitive, isolated
Throwaway extension, no specialists runtime. Fires ui.notify + pi.sendMessage(followUp, triggerTurn) from a bare setTimeout 12s after session_start. Nothing typed.

```
 Warning: PROBE: notify fired from async timer


 [wake_probe]

 PROBE-WAKE: you were woken by an extension, not by the operator. Reply with exactly the word AWAKE and nothing else.
```

## 2. End-to-end, wake enabled (VALIDATION 1)
Operator dispatched, said DISPATCHED, then touched nothing. 30s later the coordinator woke on its own.

```
 Call specialist_dispatch with specialist=live-wake-asker and bead_id=unitAI-jxcbf. Then STOP. Do not call specialist_status. Do not poll. Just say DISPATCHED and wait.


 Thinking...

• used specialist dispatch
{
  "status": "dispatched",
  "activation_id": "act:596cc3cd-973",
  "participant_id": "specialist::live-wake-asker",
  "attempt_id": "att:596cc3cd-973:1",
  "specialist": "live-wake-asker",
└─ showing 6/20 lines (ctrl+o expand) · 783ms · 688B

 Specialist wake is on: a blocked child will start a turn here on its own. Disable with --no-specialist-wake.

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Package Updates Available
 Package updates are available. Run pi update --extensions
 Packages:
 - github.com/DietrichGebert/ponytail
 - @gotgenes/pi-subagents
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

 DISPATCHED

 Specialist live-wake-asker asked a question


 [specialist_ask]

 Specialist live-wake-asker is asking a question and is blocked waiting for you.

 activation_id: act:596cc3cd-973
 bead: unitAI-jxcbf

 What is the chosen deployment colour for this wake probe (rrdnt.45 / unitAI-jxcbf)?

 Call specialist_status to read this ask's message_id from pending_asks, then answer it with specialist_reply. The child is alive and resumable; it stays blocked until you answer.


• used specialist status
{
  "activations": [
    {
      "activation_id": "act:596cc3cd-973",
      "participant_id": "specialist::live-wake-asker",
      "attempt_id": "att:596cc3cd-973:1",
└─ showing 6/31 lines (ctrl+o expand) · 1.1KB

• used specialist reply
{
  "status": "answered",
  "message_id": "msg:6759a2b9-cca",
  "in_reply_to": "msg:8b0b9be5-b93",
  "activation_id": "act:596cc3cd-973",
  "attempt_id": "att:596cc3cd-973:1"
└─ showing 6/7 lines (ctrl+o expand) · 176B

 Answered the wake probe's deployment colour question with green. The child was resumable and is now unblocked.
```

## 3. Notification path unavailable (VALIDATION 2)
Same dispatch with --no-specialist-wake. ~4 minutes of silence, no wake. The ask is still readable and is NOT marked delivered.

```
 Warning: Specialist wake is OFF (--no-specialist-wake): a blocked child will not notify you. Read its question with specialist_status.

 DISPATCHED


 Now call specialist_status once and show me the raw pending_asks entry verbatim, including its delivery field.


 Thinking... · The user wants me to call specialist_status once and show the raw pending_asks entry verbatim, including its delivery... · 124 (Ctrl+T to expand)

• used specialist status
{
  "activations": [
    {
      "activation_id": "act:4a55ff9b-7fc",
      "participant_id": "specialist::live-wake-asker",
      "attempt_id": "att:4a55ff9b-7fc:1",
└─ showing 6/31 lines (ctrl+o expand) · 2ms · 1.0KB

 The raw pending_asks entry, verbatim:

 ```json
   {
     "message_id": "msg:7fe18579-585",
     "kind": "question",
     "activation_id": "act:4a55ff9b-7fc",
     "attempt_id": "att:4a55ff9b-7fc:1",
     "from": "specialist::live-wake-asker",
     "to": "adapter::pi-extension",
     "body": "What is the chosen deployment colour for this session?",
     "delivery": "pending",
     "asked_at": 1788824475277
   }
 ```

 Its delivery field is "pending".
```

## 4. Re-run on the final tree
Repeat of (2) after the capture block was relocated and the interaction.ts delivery fix landed.

```
• used specialist reply
{
  "status": "answered",
  "message_id": "msg:ca4012b6-ea2",
  "in_reply_to": "msg:18d2d7c0-fa8",
  "activation_id": "act:5600abd0-7cf",
  "attempt_id": "att:5600abd0-7cf:1"
└─ showing 6/7 lines (ctrl+o expand) · 1ms · 176B

 Answered the ask with the deployment colour (green). The specialist is unblocked and will continue.
```
