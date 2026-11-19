import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { encodeQrPayload } from '@kindora/transport';
import { PROTOCOL_VERSION } from '@kindora/protocol';
import { PairingLink } from '../PairingLink';
import { I18nProvider } from '../../i18n';

const AGENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CODE = 'ABCDEF';

function wrap(ui: React.ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

describe('PairingLink', () => {
  it('renders the kindora:// pair URL and a QR matrix for a valid code', () => {
    wrap(<PairingLink code={CODE} agentId={AGENT} />);
    const expected = encodeQrPayload({
      code: CODE,
      agentId: AGENT,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(screen.getByTestId('pairing-link').textContent).toContain(expected);
    expect(screen.getByTestId('pairing-qr')).toBeTruthy();
  });

  it('copies the URL when the button is clicked', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    wrap(<PairingLink code={CODE} agentId={AGENT} />);
    fireEvent.click(screen.getByTestId('pairing-link-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const expected = encodeQrPayload({
      code: CODE,
      agentId: AGENT,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(writeText).toHaveBeenCalledWith(expected);
  });
});
