import os
from PIL import Image
from pillow_heif import register_heif_opener

# 註冊 HEIF 解碼器
register_heif_opener()

def convert_heic_to_jpg(heic_path):
    image = Image.open(heic_path)
    image = image.convert("RGB")
    filename = os.path.splitext(os.path.basename(heic_path))[0] + ".jpg"
    output_dir = os.path.join(os.path.dirname(__file__), "group_data")
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, filename)
    image.save(output_path, "JPEG")
    return output_path

if __name__ == "__main__":
    heic_file = r"D:\User\Developer\quiz-game\group_data\20250925_115644701_iOS.heic"  # 替換為你的 HEIC 文件路徑
    jpg_file = convert_heic_to_jpg(heic_file)
    print(f"已將 {heic_file} 轉換為 {jpg_file}")
