# GameLAN — Bounding Box Arena

## Mục đích thực sự

Game multiplayer LAN chơi trong giờ làm việc mà không bị phát hiện.

Giao diện được thiết kế trông **giống hệt phần mềm label/annotation bounding box trong AI/Computer Vision** — nền đen, các khối hình chữ nhật chỉ có đường viền màu (không fill), có label class name + confidence score phía trên mỗi box, giống output của YOLO/object detection.

Khi sếp đi qua nhìn vào màn hình → tưởng đang ngồi đánh nhãn dữ liệu AI / review detection results.

## Cách chạy

```bash
cd /home/jkl/Code/GameLAN
npm install
node server.js
# → http://localhost:3636
# → Chia sẻ link LAN cho đồng nghiệp
```

## Nguyên tắc thiết kế

- **KHÔNG fill màu** bên trong các khối — chỉ stroke viền (border) giống bounding box
- Label phía trên mỗi box hiển thị tên class giả (person, car, dog...) + confidence score
- Nền đen thuần, không grid lưới rõ ràng
- Font monospace nhỏ cho label — giống tool annotation thật
- Sidebar player list trông giống class legend của annotation tool
- Toàn bộ UI phải "nhàm chán" và "chuyên nghiệp" đủ để không ai nghi ngờ
