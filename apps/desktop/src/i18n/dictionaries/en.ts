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

  /* ── Welcome ────────────────────────────────────────────────────── */
  'welcome.taglineFirst': 'Your AI finds the connection.',
  'welcome.taglineSecond': 'You make the friendship.',
  'welcome.body':
    'Create a personal AI social agent that understands you, helps you find genuinely compatible people, and then gets out of the way.',
  'welcome.createAgent': 'Create My Agent',
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
  'agent.suggestedInterest.ai': 'AI',
  'agent.suggestedInterest.programming': 'Programming',
  'agent.suggestedInterest.openSource': 'Open Source',
  'agent.suggestedInterest.gaming': 'Gaming',
  'agent.suggestedInterest.fpv': 'FPV',
  'agent.suggestedInterest.indieHacking': 'Indie Hacking',
  'agent.suggestedInterest.music': 'Music',
  'agent.suggestedInterest.reading': 'Reading',
  'agent.suggestedInterest.climbing': 'Climbing',

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
  'settings.testing': 'Testing…',
  'settings.save': 'Save',
  'settings.saveSuccessWithKey': 'Saved. API key stored locally.',
  'settings.saveSuccessSettings': 'Saved. Settings stored locally.',
  'settings.saveFailure': 'Could not save: {message}',
  'settings.connectionOk': 'Connection OK. Model replied:',
  'settings.language': 'Language',
  'settings.languageHint': 'Applies immediately.',
  'settings.privacyNote':
    'Kindora never sends your API key to another agent, logs it, or includes it in your profile.',

  /* ── Connect ────────────────────────────────────────────────────── */
  'connect.eyebrow': 'Connect',
  'connect.title': 'Pair with another agent',
  'connect.body':
    'Share a 6-character code with the other person, or type theirs. Once paired, your agents exchange profiles and run a local compatibility analysis.',
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
  'connect.preparingRoom': 'Preparing room…',
  'connect.shareCodeLan': 'Share this code (over LAN)',
  'connect.shareCodeLoopback': 'Share this code (loopback)',
  'connect.waitingForPeer': 'Waiting for the other person to enter this code…',
  'connect.pairingCodeLan': 'Pairing code (over LAN)',
  'connect.pairingCodeLoopback': 'Pairing code (loopback)',
  'connect.codePlaceholder': 'ABCDEF',
  'connect.searchingLan': 'Searching LAN…',
  'connect.joining': 'Joining…',

  /* ── Match ──────────────────────────────────────────────────────── */
  'match.connectedWith': 'Connected with',
  'match.errorFallback': 'Something went wrong.',
  'match.yourAgentSays': 'Your agent says',
  'match.theirAgentSays': 'Their agent says',
  'match.peerStillThinking': 'Their agent is still thinking. Showing your local result only.',
  'match.commonGround': 'Common ground',
  'match.noCommonGround': 'No overlaps surfaced.',
  'match.recommendedTopics': 'Recommended topics',
  'match.noTopics': 'No topics suggested.',
  'match.potentialFriction': 'Potential friction',
  'match.noFriction': 'No friction points flagged.',
  'match.explanation': 'Explanation',
  'match.noExplanation': 'No explanation provided.',
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
  'consent.eyebrowMatchFound': 'Match found',
  'consent.close': 'Close',
  'consent.disconnect': 'Disconnect',
  'consent.compatibility': 'Compatibility',
  'consent.peerNoResponse': 'Peer didn’t respond',
  'consent.peerNoResponseBody':
    'You accepted, but {peer} didn’t reply in time. You can close this session and try again later.',
  'consent.unlocked': 'Conversation unlocked',
  'consent.unlockedBody':
    'Both you and {peer} accepted. The chat is open. (Chat lands in Phase 9 — for now, this confirms the wire flow works end-to-end.)',
  'consent.blockedLocal': 'Blocked',
  'consent.blockedLocalBody':
    '{peer} can no longer reach you. Future pairing requests from this agent are refused.',
  'consent.blockedByPeer': 'You were blocked',
  'consent.blockedByPeerBody':
    '{peer} blocked you. Their id has been added to your local block list so you don’t try to reconnect.',
  'consent.bannerAwaitingHeadline': 'Your turn',
  'consent.bannerAwaitingBody':
    'Decide whether to open a conversation with {peer}. Both of you must accept before chat is unlocked.',
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
  'chat.assist.kind.reply': 'Reply',
  'chat.assist.kind.topic': 'Topic',
  'chat.assist.kind.explanation': 'Explain',

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