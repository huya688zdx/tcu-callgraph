#include "demo.h"

/* 掉电存储块：只在 NVM 模块里读写 */
NvmBlock g_nvm;

static unsigned int s_saveCnt = 0u;

unsigned char Nvm_Checksum(const unsigned char *p, unsigned char len);
void Nvm_WriteBlock(void);

void Nvm_Init(void)
{
    g_nvm.magic = 0x5A5Au;
    g_nvm.gear = 0u;
    g_nvm.checksum = 0u;
    g_nvm.writeCnt = 0u;
    s_saveCnt = 0u;
}

/* 校验和：累加取反 */
unsigned char Nvm_Checksum(const unsigned char *p, unsigned char len)
{
    unsigned char sum = 0u;
    unsigned char i;

    for (i = 0u; i < len; i++) {
        sum = (unsigned char)(sum + p[i]);
    }
    return (unsigned char)(~sum);
}

/* 写块：带校验，写完计数加一 */
void Nvm_WriteBlock(void)
{
    unsigned char buf[4];

    buf[0] = (unsigned char)(g_nvm.magic & 0xFFu);
    buf[1] = g_nvm.gear;
    buf[2] = (unsigned char)(g_nvm.writeCnt & 0xFFu);
    buf[3] = Nvm_Checksum(buf, 3u);

    g_nvm.checksum = buf[3];
    g_nvm.writeCnt++;
}

/* 保存当前挡位 */
void Nvm_Save(void)
{
    if (g_gear.fault != 0u) {
        return;
    }
    g_nvm.gear = g_gear.current;
    Nvm_WriteBlock();
    s_saveCnt++;
}

/* 上电恢复：挡位超出范围就回落到空挡 */
void Nvm_Load(void)
{
    if (g_nvm.magic != 0x5A5Au) {
        Nvm_Init();
        return;
    }
    if (g_nvm.gear >= GEAR_COUNT) {
        g_nvm.gear = 0u;
    }
    g_gear.current = g_nvm.gear;
    g_gear.target = g_nvm.gear;
    g_gear.shiftCnt = (unsigned short)g_nvm.writeCnt;
}

unsigned int Nvm_GetSaveCount(void)
{
    return s_saveCnt;
}
