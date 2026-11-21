import { Router } from "express";
import multer from "multer";


const router = Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024 },
});

router.post(
    "/upload",

    upload.single("image"),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({
                    message: "Image is required",
                });
            }

            // Validate the actual file content in production,
            // not just the MIME type supplied by the browser.
            const allowed = ["image/jpeg", "image/png", "image/webp"];

            if (!allowed.includes(req.file.mimetype)) {
                return res.status(400).json({
                    message: "Unsupported image type",
                });
            }

            const formData = new FormData();

            formData.append(
                "image",
                new Blob([new Uint8Array(req.file.buffer)], {
                    type: req.file.mimetype,
                }),
                req.file.originalname
            );

            const response = await fetch(
                `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
                {
                    method: "POST",
                    body: formData,
                }
            );

            if (!response.ok) {
                throw new Error("ImgBB upload failed");
            }

            const result = (await response.json()) as {
                success?: boolean;
                data?: { url?: string };
            };

            if (!result.success || !result.data?.url) {
                throw new Error("Invalid ImgBB response");
            }

            return res.json({
                imageUrl: result.data.url,
            });
        } catch {
            return res.status(500).json({
                message: "Image upload failed",
            });
        }
    }
);

export default router;
