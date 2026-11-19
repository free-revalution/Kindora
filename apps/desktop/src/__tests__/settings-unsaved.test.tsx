import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Settings } from '../views/Settings';
import { I18nProvider } from '../i18n';

describe('Settings unsaved-confirm', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('asks before leaving when the model field was edited', async () => {
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <I18nProvider>
        <Settings onClose={onClose} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('settings-screen')).toBeTruthy());
    const modelInputs = screen.getAllByRole('textbox');
    const model = modelInputs.find((el) => (el as HTMLInputElement).type !== 'password') ?? modelInputs[0]!;
    fireEvent.change(model, { target: { value: 'edited-model-name' } });
    fireEvent.click(screen.getByTestId('settings-done'));
    expect(confirm).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves without prompting when nothing changed', async () => {
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <I18nProvider>
        <Settings onClose={onClose} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('settings-screen')).toBeTruthy());
    fireEvent.click(screen.getByTestId('settings-done'));
    expect(confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
