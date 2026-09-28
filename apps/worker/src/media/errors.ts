/** Файл отклонён проверкой: причина показывается редактору, в логах — вместе с sha256. */
export class MediaRejection extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'MediaRejection';
  }
}

export const reject = (reason: string): never => {
  throw new MediaRejection(reason);
};
