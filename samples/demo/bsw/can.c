#include "demo.h"

/* CAN 接收缓冲：中断里写，主循环里读 */
unsigned char g_rxBuf[RX_BUF_SIZE];
unsigned char g_rxLen = 0u;

/* 控制器内部状态：本文件私有 */
static unsigned char s_canState = 0u;
static unsigned char s_txFailCnt = 0u;

void Can_Parse(unsigned char *buf, unsigned char len);

void Can_Init(void)
{
    unsigned char i;

    for (i = 0u; i < RX_BUF_SIZE; i++) {
        g_rxBuf[i] = 0u;
    }
    g_rxLen = 0u;
    s_canState = 1u;
    s_txFailCnt = 0u;
}

/* 中断里调用：把收到的字节塞进环形缓冲 */
void Can_RxIsr(unsigned char byte)
{
    if (g_rxLen >= RX_BUF_SIZE) {
        g_rxLen = 0u;
    }
    g_rxBuf[g_rxLen] = byte;
    g_rxLen++;
}

/* 主循环轮询：有完整帧就解析 */
void Can_Poll(void)
{
    if (g_rxLen < 8u) {
        return;
    }
    Can_Parse(g_rxBuf, g_rxLen);
    g_rxLen = 0u;
}

/* 解析一帧：只认 0x18 开头的挡位报文 */
void Can_Parse(unsigned char *buf, unsigned char len)
{
    if (len < 8u || buf[0] != 0x18u) {
        s_txFailCnt++;
        return;
    }
    if (buf[1] == 0x01u) {
        g_gear.target = buf[2];
        g_ignition = 1u;
    }
}

/* 把当前挡位发出去 */
void Can_SendGearStatus(void)
{
    unsigned char frame[8];

    frame[0] = 0x18u;
    frame[1] = 0x02u;
    frame[2] = g_gear.current;
    frame[3] = g_gear.target;
    frame[4] = (unsigned char)(g_rpm >> 3);
    frame[5] = (unsigned char)(g_speed);
    frame[6] = g_gear.fault;
    frame[7] = (unsigned char)(g_tick & 0xFFu);

    if (s_canState == 0u) {
        s_txFailCnt++;
        return;
    }
    g_rxBuf[0] = frame[0];
}

unsigned char Can_GetFailCount(void)
{
    return s_txFailCnt;
}
