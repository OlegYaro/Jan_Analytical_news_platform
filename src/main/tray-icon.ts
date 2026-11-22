import { nativeImage } from 'electron';
import type { NativeImage } from 'electron';

// PNG 36×36 (@2x для 18 pt): кольцо с точкой, чёрное на прозрачном. Сгенерировано программно.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAmUlEQVR4nO2VWw7AIAgEvf+l2xM0si9qIpv0zw6DUVxrclGezXeERKscK2OXYorExBxAm5SzOwvLfQYkXupAUtz0lYX5HcMtKsTsaHk9AlcGYXkt0qk6ma1CjudihO4Wqkgh/5eLpIQgeaRLGM7UQOFMaKGEFMVPSUlct5TMY65ynOUAORv7BO7AysC0iKnPSLtUS46QmPyeF/dqWrQktyTsAAAAAElFTkSuQmCC';

/** Шаблонная иконка для строки меню macOS (цвет подбирает система). */
export function trayIcon(): NativeImage {
  const img = nativeImage.createFromBuffer(Buffer.from(PNG_BASE64, 'base64'), { scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}
