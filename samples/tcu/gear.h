#ifndef GEAR_H
#define GEAR_H

typedef enum {
    GEAR_P = 0,
    GEAR_R = 1,
    GEAR_N = 2,
    GEAR_D = 3
} GearPos;

typedef struct {
    unsigned char current;
    unsigned char target;
    unsigned int  shift_cnt;
} GearCtx;

extern GearCtx g_gearCtx;

void Gear_Init(void);
int  Gear_Apply(unsigned char target, GearCtx *ctx);
void Gear_ShiftUp(void);
void Gear_ShiftDown(void);
int  Gear_CheckSpeed(unsigned int rpm, unsigned int speed);
void EnterCritical(void);
void ExitCritical(void);

#endif
