import QRCode from "qrcode";

export async function generateQrDataUrl(
  qrString: string,
  options?: { width?: number; margin?: number }
): Promise<string> {
  return QRCode.toDataURL(qrString, {
    errorCorrectionLevel: "M",
    width: options?.width ?? 280,
    margin: options?.margin ?? 1,
  });
}
