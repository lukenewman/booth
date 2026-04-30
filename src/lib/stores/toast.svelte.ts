export interface ToastMessage {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; onClick: () => void };
}

class ToastStore {
  messages = $state<ToastMessage[]>([]);
  private nextId = 1;

  show(text: string, opts: { kind?: ToastMessage['kind']; action?: ToastMessage['action']; duration?: number } = {}) {
    const id = this.nextId++;
    const msg: ToastMessage = { id, text, kind: opts.kind ?? 'info', action: opts.action };
    this.messages = [...this.messages, msg];
    const duration = opts.duration ?? 3000;
    if (duration > 0) {
      setTimeout(() => this.dismiss(id), duration);
    }
  }

  dismiss(id: number) {
    this.messages = this.messages.filter((m) => m.id !== id);
  }
}

export const toast = new ToastStore();
