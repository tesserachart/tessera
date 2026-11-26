if (typeof Animation === 'function') {
  const cancel = Reflect.get<Animation, 'cancel'>(Animation.prototype, 'cancel');
  Animation.prototype.cancel = function cancelWithFinishedHandledAsTheSpecRequires(this: Animation) {
    this.finished.catch(() => undefined);
    cancel.call(this);
  };
}
