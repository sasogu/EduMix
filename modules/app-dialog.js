export function createAppDialog(doc = document, win = window) {
  const dialogEl = doc.getElementById('appDialog');
  const titleEl = doc.getElementById('appDialogTitle');
  const messageEl = doc.getElementById('appDialogMessage');
  const inputEl = doc.getElementById('appDialogInput');
  const selectEl = doc.getElementById('appDialogSelect');
  const choicesEl = doc.getElementById('appDialogChoices');
  const cancelBtn = doc.getElementById('appDialogCancel');
  const confirmBtn = doc.getElementById('appDialogConfirm');

  let resolver = null;
  let lastFocusedEl = null;

  function close(result) {
    if (!dialogEl || !resolver) return;
    const resolve = resolver;
    resolver = null;
    dialogEl.hidden = true;
    doc.body.classList.remove('dialog-open');
    if (inputEl) {
      inputEl.hidden = true;
      inputEl.value = '';
    }
    if (selectEl) {
      selectEl.hidden = true;
      selectEl.innerHTML = '';
    }
    if (choicesEl) {
      choicesEl.hidden = true;
      choicesEl.innerHTML = '';
    }
    const focusTarget = lastFocusedEl;
    lastFocusedEl = null;
    try { focusTarget?.focus?.(); } catch {}
    resolve(result);
  }

  function open(options = {}) {
    const {
      title = 'Mensaje',
      message = '',
      confirmText = 'Aceptar',
      cancelText = 'Cancelar',
      kind = 'alert',
      defaultValue = '',
      inputType = 'text',
      selectOptions = [],
      choiceOptions = [],
      danger = false,
    } = options || {};

    if (!dialogEl || !titleEl || !messageEl || !confirmBtn || !cancelBtn || !inputEl || !selectEl || !choicesEl) {
      if (kind === 'confirm') return Promise.resolve(win.confirm(message));
      if (kind === 'prompt') return Promise.resolve(win.prompt(message, defaultValue));
      if (kind === 'select') return Promise.resolve(win.prompt(message, defaultValue));
      if (kind === 'choice') return Promise.resolve(null);
      win.alert(message);
      return Promise.resolve(undefined);
    }

    if (resolver) {
      close(kind === 'confirm' ? false : null);
    }

    lastFocusedEl = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    titleEl.textContent = title;
    messageEl.textContent = message;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    cancelBtn.hidden = kind === 'alert' || kind === 'choice';
    confirmBtn.hidden = kind === 'choice';
    confirmBtn.classList.toggle('danger', !!danger);
    inputEl.hidden = kind !== 'prompt';
    selectEl.hidden = kind !== 'select';
    choicesEl.hidden = kind !== 'choice';
    inputEl.type = inputType;
    inputEl.value = defaultValue ?? '';
    selectEl.innerHTML = '';
    choicesEl.innerHTML = '';

    if (kind === 'select') {
      for (const optionDef of selectOptions) {
        const option = doc.createElement('option');
        option.value = String(optionDef?.value ?? '');
        option.textContent = String(optionDef?.label ?? option.value);
        selectEl.append(option);
      }
      selectEl.value = String(defaultValue ?? '');
    }

    if (kind === 'choice') {
      for (const choice of choiceOptions) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = `app-dialog-choice ${choice?.variant === 'ghost' ? 'ghost' : ''}`.trim();
        button.textContent = String(choice?.label ?? '');
        if (choice?.danger) {
          button.classList.add('danger');
        }
        button.dataset.value = String(choice?.value ?? '');
        choicesEl.append(button);
      }
    }

    dialogEl.hidden = false;
    doc.body.classList.add('dialog-open');

    return new Promise(resolve => {
      resolver = resolve;
      setTimeout(() => {
        try {
          if (kind === 'prompt') {
            inputEl.focus();
            inputEl.select();
          } else if (kind === 'select') {
            selectEl.focus();
          } else if (kind === 'choice') {
            choicesEl.querySelector('button')?.focus();
          } else {
            confirmBtn.focus();
          }
        } catch {}
      }, 0);
    });
  }

  confirmBtn?.addEventListener('click', () => {
    if (!resolver) return;
    if (!inputEl?.hidden) {
      close(inputEl.value);
      return;
    }
    if (!selectEl?.hidden) {
      close(selectEl.value);
      return;
    }
    close(true);
  });

  cancelBtn?.addEventListener('click', () => {
    if (!resolver) return;
    close(false);
  });

  dialogEl?.addEventListener('click', event => {
    if (event.target === dialogEl && resolver) {
      close(false);
    }
  });

  choicesEl?.addEventListener('click', event => {
    const button = event.target.closest('button[data-value]');
    if (!button || !resolver) return;
    close(button.dataset.value || null);
  });

  win.addEventListener('keydown', event => {
    if (!resolver || dialogEl?.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close(false);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!inputEl?.hidden) {
        close(inputEl.value);
      } else if (!selectEl?.hidden) {
        close(selectEl.value);
      } else {
        close(true);
      }
    }
  });

  return {
    alert(message, options = {}) {
      return open({ ...options, message, kind: 'alert' });
    },
    confirm(message, options = {}) {
      return open({ ...options, message, kind: 'confirm' });
    },
    prompt(message, options = {}) {
      return open({ ...options, message, kind: 'prompt' });
    },
    select(message, options = {}) {
      return open({ ...options, message, kind: 'select' });
    },
    choice(message, options = {}) {
      return open({ ...options, message, kind: 'choice' });
    },
  };
}
