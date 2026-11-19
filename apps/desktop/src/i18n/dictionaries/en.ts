/**
 * English dictionary — the SOURCE OF TRUTH for the key set.
 *
 * `TranslationKey` is derived from this object, so every other language is
 * type-checked against it: a missing or extra key is a compile error, not a
 * runtime blank string.
 *
 * Adding a language:
 *   1. Copy this file, translate the values, keep the keys identical.
 *   2. Export it as `Record<TranslationKey, string>`.
 *   3. Register it in `../locale.ts` (`LOCALES` + `SUPPORTED_LOCALES`).
 *
 * Conventions:
 *   - Keys are `<screen>.<element>`; reuse `common.*` when the same word really
 *     means the same thing in two places.
 *   - `{placeholders}` are filled by `t(key, params)`. Interpolate every
 *     number, name, or model list — never concatenate translated fragments.
 *   - Product names, provider names, model ids, base URLs, agent ids and
 *     anything the peer sent us are deliberately NOT keys.
 */

export const en = {
  /* ── Shared ─────────────────────────────────────────────────────── */
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.done': 'Done',
  'common.back': 'Back',
  'common.error': 'Error',
  'common.add': 'Add',
  'common.saving': 'Saving…',

  /* ── App shell ──────────────────────────────────────────────────── */
  'app.loading': 'Loading…',
  'app.keychainErrorTitle': 'Your private key could not be loaded',
  'app.keychainErrorRetry': 'Try again',
  'app.keychainError.locked': 'Your system keychain is locked.',
  'app.keychainError.lockedHint':
    'Unlock your macOS Keychain (or Windows Credential Manager / Linux Secret Service), then press Try again.',
  'app.keychainError.denied': 'Your system keychain denied access to Kindora’s key.',
  'app.keychainError.deniedHint':
    'Allow Kindora when the OS asks for keychain access, then press Try again.',
  'app.keychainError.unavailable':
    'No system keychain is available on this device, so the private key cannot be stored safely.',
  'app.keychainError.unavailableHint':
    'Use the packaged desktop app on a machine with a working OS keychain.',
  'app.keychainError.notFound': 'No private key was found for this agent.',
  'app.keychainError.notFoundHint':
    'The agent record is present but the keychain entry is missing. Creating a new agent may be required.',
  'app.keychainError.corrupt': 'The stored private key could not be read.',
  'app.keychainError.corruptHint':
    'The keychain entry looks damaged. Creating a new agent may be required.',
  'app.keychainError.invalidKey': 'The private key was rejected by the system keychain.',
  'app.keychainError.invalidKeyHint':
    'The stored material is not a usable key. Creating a new agent may be required.',
  'app.keychainError.generic': 'The system keychain reported an error.',
  'app.keychainError.genericHint': 'See the detail below, then try again after fixing the cause.',
  'app.keychainError.createNew': 'Create a new agent',
  'app.databaseErrorTitle': 'Your local database could not be opened',
  'app.databaseErrorRetry': 'Try again',
  'app.errorBoundaryTitle': 'Something went wrong',
  'app.errorBoundaryBody':
    'This screen crashed. Your data on disk was not modified. You can try again.',
  'app.persistenceError':
    'Chat history could not be saved. The conversation can continue, but this message may be lost after a restart.',
  'app.icebreakerErrorTitle': 'Icebreaker could not be generated',
  'app.icebreakerErrorBody':
    'The match succeeded, but the icebreaker request failed. You can retry, skip to chat, or disconnect.',
  'app.icebreakerRetry': 'Retry icebreaker',
  'app.icebreakerSkip': 'Skip to chat',
  'app.keyBoundaryNote':
    'Security note: the desktop app stores your identity key in the OS keychain, but signing still happens in the app window. A harder boundary (native signing) is planned; treat this build as a developer preview.',
  'home.keychainDevWarning':
    'Browser preview: your private key is kept in this browser’s local storage, not in the system keychain. Use the desktop app for real protection.',

  /* ── Navigation ─────────────────────────────────────────────────── */
  'nav.tagline': 'Local-first social agents',
  'nav.agent': 'Agent',
  'nav.connect': 'Connect',
  'nav.history': 'History',
  'nav.blocked': 'Blocked',
  'nav.settings': 'Settings',
  'nav.demo': 'Demo',
  'nav.noAgent': 'No agent yet',
  'nav.agentReady': 'Ready on this device',
  'nav.agentMissing': 'Create an agent to begin',
  'flow.connect': 'Connect',
  'flow.identify': 'Identify',
  'flow.consent': 'Consent',
  'flow.match': 'Match',
  'flow.icebreaker': 'Icebreaker',
  'flow.chat': 'Chat',

  /* ── Welcome ────────────────────────────────────────────────────── */
  'welcome.taglineFirst': 'Your AI finds the connection.',
  'welcome.taglineSecond': 'You make the friendship.',
  'welcome.body':
    'Create a personal AI social agent that understands you, helps you find genuinely compatible people, and then gets out of the way.',
  'welcome.createAgent': 'Create My Agent',
  'welcome.tryDemo': 'Try the demo',
  'welcome.footer': 'Local-first · Open source · MIT',

  /* ── Home ───────────────────────────────────────────────────────── */
  'home.myAgent': 'My Agent',
  'home.unnamed': 'Unnamed',
  'home.settings': 'Settings',
  'home.editProfile': 'Edit Profile',
  'home.interests': 'Interests',
  'home.noInterests': 'No interests yet.',
  'home.currently': 'Currently',
  'home.lookingFor': 'Looking for',
  'home.conversationStyle': 'Conversation style',
  'home.connectAgent': 'Connect Agent',
  'home.connectHint':
    'LAN for the same Wi-Fi; WebRTC “Same device” to try two windows on this computer; copy/paste SDP for another network.',
  'home.tryDemo': 'Run the local demo',
  'home.blockedAgents': 'Blocked agents',
  'home.chatHistory': 'Chat history',
  'home.intent.similar_interests': 'Similar interests',
  'home.intent.project_partner': 'Project partners',
  'home.intent.gaming_partner': 'Gaming partners',
  'home.intent.learning_partner': 'Learning partners',
  'home.intent.technical_discussion': 'Technical discussion',
  'home.intent.long_term_friendship': 'Long-term friendship',
  'home.intent.activity_partner': 'Activity partners',

  /* ── Create / edit agent ────────────────────────────────────────── */
  'agent.createTitle': 'Create your agent',
  'agent.editTitle': 'Edit your agent',
  'agent.body':
    'This profile is stored locally and only the public parts are ever shared with another agent.',
  'agent.nickname': 'Nickname',
  'agent.nicknamePlaceholder': 'Jason',
  'agent.bio': 'Bio',
  'agent.bioPlaceholder': 'Software engineer interested in AI agents.',
  'agent.interests': 'Interests',
  'agent.interestsHint': 'Up to {max}',
  'agent.interestsEmpty': 'Pick a few from below or type your own.',
  'agent.interestsPlaceholder': 'Add an interest and press Enter',
  'agent.currentActivities': 'Current activities',
  'agent.currentActivitiesHint': 'Up to {max} — only shared if your boundaries allow it',
  'agent.currentActivitiesPlaceholder': 'Building an AI Social Agent project.',
  'agent.socialIntent': 'Social intent',
  'agent.socialIntentHint': "Pick what you're looking for. Pick at least one.",
  'agent.conversationStyle': 'Conversation style',
  'agent.conversationStyleHint': 'Pick at least one.',
  'agent.createSubmit': 'Create Agent',
  'agent.saveSubmit': 'Save',
  'agent.removeItem': 'Remove {value}',
  'agent.intent.similar_interests': 'Meet people with similar interests',
  'agent.intent.project_partner': 'Find project partners',
  'agent.intent.gaming_partner': 'Find gaming partners',
  'agent.intent.learning_partner': 'Find learning partners',
  'agent.intent.technical_discussion': 'Discuss technical topics',
  'agent.intent.long_term_friendship': 'Make long-term friends',
  'agent.intent.activity_partner': 'Find activity partners',
  'agent.style.casual': 'Casual',
  'agent.style.deep': 'Deep',
  'agent.style.technical': 'Technical',
  'agent.style.funny': 'Funny',
  'agent.style.quiet': 'Quiet',
  'agent.interestCategory.tech': 'Tech',
  'agent.interestCategory.creative': 'Creative',
  'agent.interestCategory.outdoors': 'Outdoors',
  'agent.interestCategory.games': 'Games',
  'agent.interestCategory.learning': 'Learning',
  'agent.interestCategory.social': 'Social',
  'agent.suggestedInterest.ai': 'AI',
  'agent.suggestedInterest.programming': 'Programming',
  'agent.suggestedInterest.openSource': 'Open Source',
  'agent.suggestedInterest.indieHacking': 'Indie Hacking',
  'agent.suggestedInterest.music': 'Music',
  'agent.suggestedInterest.writing': 'Writing',
  'agent.suggestedInterest.design': 'Design',
  'agent.suggestedInterest.climbing': 'Climbing',
  'agent.suggestedInterest.hiking': 'Hiking',
  'agent.suggestedInterest.fpv': 'FPV',
  'agent.suggestedInterest.gaming': 'Gaming',
  'agent.suggestedInterest.boardGames': 'Board Games',
  'agent.suggestedInterest.reading': 'Reading',
  'agent.suggestedInterest.languages': 'Languages',
  'agent.suggestedInterest.coffee': 'Coffee',
  'agent.suggestedInterest.cooking': 'Cooking',

  /* ── Privacy boundaries (Phase B / B1) ──────────────────────────── */
  'privacy.title': 'Privacy',
  'privacy.intro':
    'These switches decide what leaves this device. Every field is filtered before it goes on the wire — a field you switch off is not sent at all, not sent and hidden afterwards.',
  'privacy.behaviourTitle': 'What other agents may do',
  'privacy.behaviourIntro': 'Permissions for the conversation itself.',
  'privacy.fieldsTitle': 'Which parts of your profile are visible',
  'privacy.fieldsIntro':
    'Your profile is filtered field by field. A field you switch off is removed before the profile is sent.',
  'privacy.visible': 'Shared',
  'privacy.hidden': 'Private',
  'privacy.allowAgentConversation': 'Let other agents start a conversation',
  'privacy.allowAgentConversationHint':
    'Turn this off and your agent will not take part in agent-assisted conversations. You can still write to the chat yourself.',
  'privacy.allowContactExchange': 'Share contact details',
  'privacy.allowContactExchangeHint':
    'Lets the other agent ask for, and be given, contact details such as an email address or a phone number.',
  'privacy.allowOfflineMeeting': 'Agree to meet offline',
  'privacy.allowOfflineMeetingHint':
    'Lets the other agent suggest meeting in person. Kindora never arranges a meeting by itself.',
  'privacy.allowProjectDetails': 'Share project-level details',
  'privacy.allowProjectDetailsHint':
    'Lets the other agent see code, repositories or customer details. Leave this off unless you mean it.',
  'privacy.allowBio': 'Your bio',
  'privacy.allowBioHint':
    'Your free-text self-description. Off by default — it often says more about you than you intend.',
  'privacy.allowInterests': 'Your interests',
  'privacy.allowInterestsHint':
    'The topics you listed above. Shared by default: without them there is no common ground to match on.',
  'privacy.allowCurrentActivity': 'What you are doing right now',
  'privacy.allowCurrentActivityHint':
    'Your current activities. Off by default — this is the freshest, most revealing part of a profile.',
  'privacy.allowAvatar': 'Your avatar',
  'privacy.allowAvatarHint': 'An image representing you. Off by default.',
  'privacy.allowSocialIntent': 'What you are looking for',
  'privacy.allowSocialIntentHint':
    'The kinds of people you want to meet. Shared by default — it is what makes the match meaningful.',
  'privacy.allowConversationStyle': 'Your conversation style',
  'privacy.allowConversationStyleHint':
    'How you like to talk. Shared by default — it tells the other agent how to approach you.',

  /* ── Blocked agents (Phase B / B3) ──────────────────────────────── */
  'blocked.title': 'Blocked agents',
  'blocked.intro':
    'These agents cannot pair with you. A blocked agent is refused during the handshake, before it learns anything about you.',
  'blocked.empty': 'You have not blocked anyone.',
  'blocked.unblock': 'Unblock',
  'blocked.blockedAt': 'Blocked on {date}',
  'blocked.reason': 'Reason: {reason}',
  'blocked.noReason': 'No reason recorded',
  'blocked.agentId': 'Agent id',

  /* ── Profile validation ─────────────────────────────────────────── */
  'validation.nickname_required': 'Nickname is required.',
  'validation.nickname_too_long': 'Nickname must be {max} characters or fewer.',
  'validation.bio_required': 'Bio is required.',
  'validation.bio_too_long': 'Bio must be {max} characters or fewer.',
  'validation.interests_required': 'Add at least one interest.',
  'validation.interests_too_many': 'At most {max} interests.',
  'validation.activities_too_many': 'At most {max} current activities.',
  'validation.social_intent_required': 'Select at least one social intent.',
  'validation.social_intent_too_many': 'At most {max} social intents.',
  'validation.conversation_style_required': 'Select at least one conversation style.',
  'validation.conversation_style_too_many': 'At most {max} conversation styles.',

  /* ── Settings ───────────────────────────────────────────────────── */
  'settings.loading': 'Loading settings…',
  'settings.title': 'Settings',
  'settings.done': 'Done',
  'settings.llmProvider': 'LLM Provider',
  'settings.provider': 'Provider',
  'settings.baseUrl': 'Base URL',
  'settings.model': 'Model',
  'settings.suggestions': 'Suggestions: {models}',
  'settings.apiKey': 'API Key',
  'settings.apiKeyPlaceholderSaved': '•••••••• (saved) — enter to replace',
  'settings.apiKeyPlaceholderEmpty': 'sk-…',
  'settings.apiKeyStorageNote':
    'Stored locally only — encrypted at rest (browser dev) or in OS keychain (Tauri).',
  'settings.apiKeyStoredNote':
    'An API key is stored for this provider. It is never displayed — type a new one to replace it.',
  'settings.apiKeyClear': 'Remove saved key',
  'settings.apiKeyCleared': 'Saved API key removed.',
  'settings.apiKeyClearFailed': 'Could not remove the saved key: {message}',
  'settings.testConnection': 'Test Connection',
  'settings.ollamaLoopbackHint':
    'Ollama must run on this machine. Use http://127.0.0.1:11434 (or localhost). Remote hosts are blocked.',
  'settings.testing': 'Testing…',
  'settings.save': 'Save',
  'settings.saveSuccessWithKey': 'Saved. API key stored locally.',
  'settings.saveSuccessSettings': 'Saved. Settings stored locally.',
  'settings.saveFailure': 'Could not save: {message}',
  'settings.connectionOk': 'Connection OK. Model replied:',
  'settings.language': 'Language',
  'settings.languageHint': 'Applies immediately.',
  'settings.transportTitle': 'Transports',
  'settings.transportBody':
    'LAN needs the desktop app. WebRTC needs RTCPeerConnection (Tauri WebView / modern browsers) and uses a local self-test that never leaves this device.',
  'settings.webrtcAvailable': 'available',
  'settings.webrtcUnavailable': 'not available in this runtime',
  'settings.webrtcSelfTest': 'Test WebRTC (local loop)',
  'settings.iceServers': 'ICE servers (STUN/TURN)',
  'settings.iceServersHint':
    'One stun: or turn: URL per line. Used by WebRTC pairing. Leave default Google STUN unless you have your own.',
  'settings.iceServersSave': 'Save ICE servers',
  'settings.iceServersReset': 'Reset to defaults',
  'settings.iceServersSaved': 'ICE servers saved for this browser / app profile.',
  'settings.signallingUrl': 'WebRTC signalling URL (Mode C)',
  'settings.signallingUrlHint':
    'HTTP base URL of your signalling server, e.g. http://127.0.0.1:8787. Run `node tools/kindora-signalling-server.mjs`. Leave empty to disable Mode C.',
  'settings.signallingUrlSave': 'Save signalling URL',
  'settings.signallingUrlClear': 'Clear',
  'settings.signallingUrlSaved': 'Signalling URL saved for this browser / app profile.',
  'settings.unsavedConfirm':
    'You have unsaved LLM settings. Leave without saving?',
  'settings.privacyNote':
    'Kindora never sends your API key to another agent, logs it, or includes it in your profile.',

  /* ── LLM failures (Phase E / E1) ─────────────────────────────────── */
  'llm.error.auth': 'Check the API key in Settings and save it again.',
  'llm.error.rateLimit': 'The provider is rate limiting requests — wait a moment and try again.',
  'llm.error.timeout': 'The provider did not answer in time — check your network and try again.',
  'llm.error.network': 'Could not reach the provider — check your network and the base URL.',
  'llm.error.invalidResponse':
    'The provider answered with something unexpected — check the model name.',
  'llm.error.provider': 'The provider reported an error — check the model name and try again.',
  'llm.error.aborted': 'The request was cancelled.',

  /* ── Connect ────────────────────────────────────────────────────── */
  'connect.eyebrow': 'Connect',
  'connect.title': 'Pair with another agent',
  'connect.body':
    'Share the 6-character identity fingerprint with the other person, or type theirs. Once paired, your agents exchange profiles and run a local compatibility analysis.',
  'connect.llmNotConfigured': 'LLM not configured',
  'connect.llmNotConfiguredBody':
    'Configure an LLM provider in Settings before pairing. Pairing exchanges profiles and runs a local analysis, which needs an LLM.',
  'connect.llmMissingApiKeyTitle': 'API key not found',
  'connect.llmMissingApiKeyBody':
    'Your provider is saved, but its API key is not in the keychain. Re-enter the key in Settings and save again.',
  'connect.llmInvalidConfigTitle': 'Provider configuration is incomplete',
  'connect.llmInvalidConfigBody':
    'The saved provider cannot be used. Open Settings and check the base URL and model.',
  'connect.host': 'Host',
  'connect.join': 'Join',
  'connect.lan': 'LAN',
  'connect.lanTitle':
    'LAN: real UDP discovery + TCP message channel between two Tauri clients on the same network.',
  'connect.lanUnavailableTitle':
    'LAN mode is only available in the Tauri desktop app (not in browser dev).',
  'connect.loopback': 'Loopback',
  'connect.loopbackTitle': 'Loopback: in-process pairing (browser dev / single-machine tests).',
  'connect.webrtc': 'WebRTC',
  'connect.webrtcTitle':
    'WebRTC: cross-network pairing via a DataChannel. You exchange SDP blobs by hand (copy/paste); STUN helps with NAT.',
  'connect.webrtcUnavailableTitle':
    'WebRTC is not available in this runtime (RTCPeerConnection missing).',
  'connect.preparingRoom': 'Preparing room…',
  'connect.shareCodeLan': 'Share this identity fingerprint (over LAN)',
  'connect.shareCodeLoopback': 'Share this identity fingerprint (loopback)',
  'connect.shareCodeWebRtc': 'Share this identity fingerprint, then the offer blob',
  'connect.waitingForPeer': 'Waiting for the other person to enter this fingerprint…',
  'connect.waitingForAnswer': 'Waiting for the other person to paste their answer blob…',
  'connect.webrtcConnecting': 'Signalling done — opening the DataChannel…',
  'connect.badSignalBlob':
    'That does not look like a Kindora signalling blob. Copy the whole Answer text from the other device and try again.',
  'connect.lab': 'Same device',
  'connect.manual': 'Copy/paste',
  'connect.labTitle':
    'Lab: two windows on this computer exchange SDP over BroadcastChannel — no copy/paste.',
  'connect.labUnavailable': 'BroadcastChannel is not available in this runtime.',
  'connect.manualTitle': 'Manual Mode B: exchange SDP blobs by copy/paste across networks.',
  'connect.server': 'Signalling server',
  'connect.serverTitle':
    'Mode C: exchange SDP through your HTTP signalling server (URL in Settings).',
  'connect.serverUnavailable':
    'Set a signalling URL in Settings (e.g. http://127.0.0.1:8787) to enable Mode C.',
  'connect.serverWaiting':
    'Waiting for the peer on the signalling server — they join with this fingerprint.',
  'connect.labWaiting':
    'Waiting for another window on this device to join with this fingerprint…',
  'connect.labJoinHint':
    'Open a second Kindora window, start Host with the same “Same device” mode, then enter that host fingerprint here.',
  'connect.webrtcTimeout':
    'WebRTC did not connect in time. Check ICE servers in Settings, or try again with both sides online.',
  'connect.leaveToHome': 'Back to home',
  'connect.pairingCodeLan': 'Identity fingerprint (over LAN)',
  'connect.pairingCodeLoopback': 'Identity fingerprint (loopback)',
  'connect.pairingCodeWebRtc': 'Host identity fingerprint',
  'connect.codePlaceholder': 'A1B2-C3',
  'connect.offerBlob': 'Offer blob (copy this)',
  'connect.answerBlob': 'Answer blob (copy this)',
  'connect.pasteAnswer': 'Paste their answer blob',
  'connect.pasteOffer': 'Paste their offer blob',
  'connect.copyBlob': 'Copy',
  'connect.copied': 'Copied',
  'connect.applyAnswer': 'Apply answer',
  'connect.createAnswer': 'Create answer',
  'connect.webrtcPreparing': 'Preparing WebRTC offer…',
  'connect.pairUrl': 'Pairing link',
  'connect.copyPairUrl': 'Copy link',
  'connect.copyFingerprint': 'Copy fingerprint',
  'connect.qrLabel': 'Pairing QR code',
  'connect.pairUrlHint':
    'Scan the QR or paste the link into Join — or type the fingerprint by hand.',
  'connect.fingerprintHint':
    'Read these 6 characters out loud and check that the other device shows the same ones. This is an identity fingerprint — it identifies the host. It is not a password and it does not open anything by itself.',
  'connect.localFingerprintHint':
    'Show these 6 characters to the host so they can confirm it is you. This is your identity fingerprint — not a password.',
  'connect.localFingerprintLabel': 'Your fingerprint (for the host)',
  'connect.peerFingerprintEyebrow': 'Confirm identity',
  'connect.peerFingerprintTitle': 'Does this match the other device?',
  'connect.peerFingerprintBody':
    'Read these characters out loud with {name}. Continue only when both of you see the same fingerprint.',
  'connect.peerFingerprintHint':
    'Until you confirm, Kindora will not allow consent or chat with this peer.',
  'connect.peerFingerprintConfirm': 'Fingerprints match',
  'connect.peerFingerprintConfirming': 'Confirming…',
  'connect.peerFingerprintMissing':
    'The peer did not send a public key, so a fingerprint cannot be shown.',
  'connect.fingerprintMismatch':
    'The other device does not match this fingerprint, so the connection was closed.',
  'connect.peerDisconnected': 'The other device disconnected, so the connection was closed.',
  'connect.limitExceeded':
    'The other device sent more data than the connection allows, so the connection was closed.',
  'connect.invalidFrame':
    'The other device sent data that could not be read, so the connection was closed.',
  'connect.searchingLan': 'Searching LAN…',
  'connect.joining': 'Joining…',

  /* ── Connection lifecycle (Phase C / C3 § 8) ─────────────────────── */
  'connect.state.connecting': 'Connecting…',
  'connect.state.connected': 'Connected',
  'connect.state.disconnected': 'Disconnected',
  'connect.state.reconnecting': 'Reconnecting…',
  'connect.state.failed': 'Connection failed',
  'connect.state.idle': 'Not connected',
  'connect.reconnect': 'Reconnect',
  'connect.reconnecting': 'Reconnecting — the security handshake is being redone.',
  'connect.reconnectFailed':
    'The reconnect attempt failed. Check that the other device is still running.',

  /* ── Identify (Phase B) ─────────────────────────────────────────── */
  'identify.eyebrow': 'Step 1 of 3',
  'identify.title': 'Exchanging public cards',
  'identify.progress': 'Exchanging public cards…',
  'identify.body':
    'At this stage only a minimal public card is sent — a name and, if they allow it, what they are looking for. Your full profile stays on this device until both sides agree.',

  /* ── Match ──────────────────────────────────────────────────────── */
  'match.connectedWith': 'Connected with',
  'match.errorFallback': 'Something went wrong.',
  'match.yourAgentSays': 'Your agent says',
  'match.theirAgentSays': 'Their agent says',
  'match.peerStillThinking': 'Their agent is still thinking. Showing your local result only.',
  'match.degradedTitle': 'Partial analysis',
  'match.degradedBody':
    'The model reply was incomplete or unreadable in places. Shared tags below may come from deterministic interest overlap instead of the model narrative.',
  'match.peerTimedOut': 'Their analysis did not arrive in time. Showing your local result only.',
  'match.commonGround': 'Common ground',
  'match.noCommonGround': 'No overlaps surfaced.',
  'match.recommendedTopics': 'Recommended topics',
  'match.noTopics': 'No topics suggested.',
  'match.potentialFriction': 'Potential friction',
  'match.noFriction': 'No friction points flagged.',
  'match.explanation': 'Explanation',
  'match.noExplanation': 'No explanation provided.',
  'match.overlapTitle': 'Overlap scores',
  'match.overlapHint':
    'Deterministic scores that grounded the analysis. The signal above still comes from the model (or a safe fallback).',
  'match.overlap.interest': 'Interests',
  'match.overlap.intent': 'Intent',
  'match.overlap.style': 'Style',
  'match.overlap.activity': 'Activities',
  'match.overlap.composite': 'Composite',
  'match.progressConnecting': 'Connecting…',
  'match.progressExchanging': 'Exchanging profiles…',
  'match.progressAnalysing': 'Your agent is analysing compatibility…',
  'match.progressWorking': 'Working…',
  'match.signal.strong': 'Strong match',
  'match.signal.moderate': 'Moderate match',
  'match.signal.weak': 'Weak match',
  'match.signal.none': 'No match',

  /* ── Consent ────────────────────────────────────────────────────── */
  'consent.eyebrowAccepted': 'Connected with',
  'consent.eyebrowBlocked': 'Blocked',
  'consent.eyebrowClosed': 'Connection closed',
  'consent.eyebrowPeerFound': 'Peer found',
  'consent.close': 'Close',
  'consent.disconnect': 'Disconnect',
  'consent.publicCard': 'Their public card',
  'consent.publicCardEmpty':
    'This agent did not share a public card. You can still accept — but you are deciding without knowing anything about them.',
  'consent.publicCardNote':
    'This is everything they have shared so far. The rest of their profile is only sent after both sides accept.',
  'consent.cardNickname': 'Name',
  'consent.cardIntent': 'Looking for',
  'consent.cardStyle': 'Conversation style',
  'consent.cardHidden': 'Not shared',
  'consent.peerNoResponse': 'Peer didn’t respond',
  'consent.peerNoResponseBody':
    'You accepted, but {peer} didn’t reply in time. You can close this session and try again later.',
  'consent.unlocked': 'Conversation unlocked',
  'consent.unlockedBody':
    'Both you and {peer} accepted. Your profiles are now exchanged and your agent is analysing compatibility.',
  'consent.blockedLocal': 'Blocked',
  'consent.blockedLocalBody':
    '{peer} can no longer reach you. Future pairing requests from this agent are refused.',
  'consent.blockedByPeer': 'You were blocked',
  'consent.blockedByPeerBody':
    '{peer} blocked you. Their id has been added to your local block list so you don’t try to reconnect.',
  'consent.bannerAwaitingHeadline': 'Your turn',
  'consent.bannerAwaitingBody':
    'Decide whether to open a conversation with {peer}. Both of you must accept before your full profiles are exchanged.',
  'consent.bannerAcceptedLocalHeadline': 'Waiting for them',
  'consent.bannerAcceptedLocalBody': 'You accepted. Waiting for {peer} to accept too.',
  'consent.bannerAcceptedPeerHeadline': 'They accepted',
  'consent.bannerAcceptedPeerBody': '{peer} accepted. Click Accept to unlock the conversation.',
  'consent.bannerAcceptedBothHeadline': 'Both accepted',
  'consent.bannerAcceptedBothBody': 'Conversation unlocked.',
  'consent.bannerRejectedHeadline': 'Connection rejected',
  'consent.bannerRejectedBody': 'The match was declined.',
  'consent.bannerBlockedHeadline': 'Blocked',
  'consent.bannerBlockedBody': 'Future pairing requests from this agent are refused.',
  'consent.whatToDo': 'What do you want to do?',
  'consent.accept': 'Accept',
  'consent.reject': 'Reject',
  'consent.block': 'Block',
  'consent.actionsNote':
    'Block stores the peer’s id locally so they can’t pair with you again. Reject closes this connection only.',

  /* ── Icebreaker ─────────────────────────────────────────────────── */
  'icebreaker.eyebrow': 'Pick a starter',
  'icebreaker.you': 'You: {name}',
  'icebreaker.howItWorks': 'How icebreakers work',
  'icebreaker.howItWorksBody':
    'Your agent suggests up to {max} conversation starters based on both profiles. Pick one to send, edit it, ask for new ones, or skip straight to chat. Nothing is sent automatically — the choice is yours.',
  'icebreaker.generationFailed': 'Generation failed',
  'icebreaker.unknownError': 'Unknown error.',
  'icebreaker.tryAgain': 'Try again',
  'icebreaker.disabled': 'Icebreaker disabled',
  'icebreaker.disabledBody':
    'Both profiles disallow agent-assisted conversation starters. You can still enter the chat and write your own message.',
  'icebreaker.couldNotGenerate': 'Couldn’t generate starters',
  'icebreaker.heuristicSeedTitle': 'Fallback starters',
  'icebreaker.heuristicSeedBody':
    'The model did not return usable openers, so these drafts come from recommended topics or shared interests. Edit freely before sending.',
  'icebreaker.drafting': 'Drafting starters',
  'icebreaker.thinking': 'Your agent is thinking about what to say…',
  'icebreaker.empty':
    'No starters yet — click Regenerate to ask your agent again, or Skip to enter the chat directly.',
  'icebreaker.useEdited': 'Use edited',
  'icebreaker.use': 'Use',
  'icebreaker.edit': 'Edit',
  'icebreaker.or': 'Or',
  'icebreaker.generate': 'Generate starters',
  'icebreaker.regenerate': 'Regenerate',
  'icebreaker.skip': 'Skip — enter chat',
  'icebreaker.aiOnlySuggests': 'AI only suggests — it never sends anything for you.',

  /* ── Chat ───────────────────────────────────────────────────────── */
  'chat.eyebrow': 'Chat with',
  'chat.you': 'You: {name}',
  'chat.back': 'Back',
  'chat.disconnect': 'Disconnect',
  'chat.blockedLocal': 'Blocked',
  'chat.blockedLocalBody':
    'You blocked {peer}. Their id is on your local block list; future pairing requests will be refused automatically.',
  'chat.blockedByPeer': 'You were blocked',
  'chat.blockedByPeerBody':
    '{peer} blocked you. Their id has been added to your local block list so you don’t try to reconnect.',
  'chat.peerLeft': '{peer} closed the conversation.',
  'chat.emptyOpen': 'No messages yet — say hi.',
  'chat.emptyClosed': 'No messages exchanged.',
  'chat.message': 'Message',
  'chat.inputClosed': 'Chat is closed.',
  'chat.inputOpen': 'Message {peer}…',
  'chat.sending': 'Sending…',
  'chat.send': 'Send',
  'chat.alreadyBlocked': 'Already blocked',
  'chat.block': 'Block',
  'chat.aiNeverSends': 'AI never sends — every entry here came from a real human.',
  'chat.opening': 'Opening chat…',
  'chat.bubbleYou': 'You',
  'chat.fromAgent': 'from your agent',
  'chat.statusPending': 'Sending…',
  'chat.statusFailed': 'Not sent',
  'chat.assist.closedPrompt': 'Stuck? Ask your agent for help.',
  'chat.assist.open': 'Ask My Agent',
  'chat.assist.title': 'Ask My Agent',
  'chat.assist.subtitle':
    'Suggestions from your agent. The human reviews every one — nothing is sent until you click Send yourself.',
  'chat.assist.close': 'Close',
  'chat.assist.unavailableFallback': 'Assistant is not available right now (no LLM configured).',
  'chat.assist.queryLabel': 'What do you want help with?',
  'chat.assist.queryPlaceholder':
    'e.g. "help me reply to their last message" or "what should I ask them next?"',
  'chat.assist.aiOnlySuggests': 'AI only suggests — it never sends for you.',
  'chat.assist.thinking': 'Thinking…',
  'chat.assist.ask': 'Ask',
  'chat.assist.reading': 'Your agent is reading the chat…',
  'chat.assist.noSuggestions': 'No suggestions came back.',
  'chat.assist.regenerate': 'Regenerate',
  'chat.assist.useEdited': 'Use edited',
  'chat.assist.use': 'Use',
  'chat.assist.edit': 'Edit',
  'chat.assist.dismiss': 'Dismiss',
  'chat.assist.boundaryBlocked':
    'Both profiles disallow agent conversation — assistant is disabled for this chat.',
  'chat.assist.heuristicSeed':
    'The model did not return usable drafts, so these suggestions come from recommended topics or shared interests. Edit freely before sending.',
  'chat.assist.kind.reply': 'Reply',
  'chat.assist.kind.topic': 'Topic',
  'chat.assist.kind.explanation': 'Explain',

  /* ── Chat history ───────────────────────────────────────────────── */
  'history.eyebrow': 'Saved on this device',
  'history.title': 'Chat history',
  'history.unavailable':
    'Chat history is kept by the desktop app only. The browser preview stores nothing between sessions.',
  'history.loading': 'Loading conversations…',
  'history.empty': 'No conversations yet. The ones you have will show up here.',
  'history.selectPrompt': 'Select a conversation to read it.',
  'history.transcriptEmpty': 'This conversation has no messages.',
  'history.unnamedPeer': 'Unnamed peer',
  'history.messageCount': '{count} messages',
  'history.ended': 'ended',
  'history.active': 'active',
  'history.peer': 'Peer',
  'history.fromAgent': 'from your agent',
  'history.statusPending': 'Never sent.',
  'history.statusFailed': 'Not sent.',

  /* ── Local demo mode ───────────────────────────────────────────── */
  'demo.banner':
    'Local demo — simulated agents on this machine. No network, no language model, no other people.',
  'demo.stepsLabel': 'Demo steps',
  'demo.step.intro': 'Intro',
  'demo.step.meet': 'Meet',
  'demo.step.consent': 'Consent',
  'demo.step.match': 'Match report',
  'demo.step.icebreaker': 'Icebreaker',
  'demo.step.chat': 'Chat',
  'demo.eyebrow': 'Local demo',
  'demo.introTitle': 'See the whole loop in two minutes',
  'demo.introBody':
    'Kindora works by putting two personal AI agents in the same room and letting them find what you have in common — then leaving the decision to you. This demo walks through that loop on this machine, without a second device and without an API key.',
  'demo.whatIsReal': 'What is real here',
  'demo.realProfiles':
    'The profile model, the privacy filter and the public card are the real ones.',
  'demo.realHeuristics':
    'The overlap scoring is the real deterministic matcher from the agent package.',
  'demo.realParsing':
    'The report is produced by the real prompt builder and the real output parser.',
  'demo.realScreens': 'Every screen you will see is the shipping product UI.',
  'demo.whatIsSimulated': 'What is simulated',
  'demo.simulatedModel':
    'No language model is called. A local deterministic stand-in answers the same prompt.',
  'demo.simulatedPeer':
    'The other person is a fixture profile. They are not real and not online.',
  'demo.simulatedNetwork':
    'Nothing is sent anywhere. There is no peer on your LAN and no server.',
  'demo.start': 'Start the demo',
  'demo.exit': 'Not now',
  'demo.meetEyebrow': 'Step 1',
  'demo.meetTitle': 'Two agents, two people',
  'demo.meetBody':
    'Each person writes their own agent: a nickname, a short bio, a handful of interests and what they are doing right now. Here are the two demo agents.',
  'demo.you': 'Your agent',
  'demo.peer': 'The demo peer',
  'demo.continue': 'Continue',
  'demo.continueToMatch': 'Continue to the match report',
  'demo.continueToChat': 'Continue to the chat',
  'demo.chatNotice':
    'The peer in this demo is scripted: their three replies are fixed and do not depend on what you type. A real session would carry your messages to another device.',
  'demo.finish': 'Finish the demo',

  /* ── Language picker ────────────────────────────────────────────── */
  'language.label': 'Language',
} as const;

/** Every key the UI may ask for. Derived from `en`. */
export type TranslationKey = keyof typeof en;

/**
 * A complete dictionary. Declaring other languages as `Record<TranslationKey, string>`
 * makes a missing key a compile error rather than a blank label at runtime.
 */
export type Dictionary = Record<TranslationKey, string>;

export type TranslationParams = Readonly<Record<string, string | number>>;
